#!/usr/bin/env ruby
# frozen_string_literal: true

# Per-role eval runner: runs one Autobots role headless against real repo
# fixtures and grades the end state. The case set lives in
# evals/roles/coding-worker; each writable role (--role) gets its own flow dir.
#
# Each case names a public repo, a base commit, a task prompt, and a hidden
# test. For every (case, rep) the runner clones the base commit into a temp
# workspace, pins the role file there with the arm's model and effort, runs
# `claude -p --agent <role> --effort <effort>`, then grades what the agent left
# behind: the hidden test passes, the repo's own suite passes, nothing
# off-limits changed, and something did change.
#
# Output follows the /claude-api build-eval layout, rooted at the flow dir
# (evals/roles/<role>/runs):
#   <flow>/<variant>/results.jsonl, traces/<id>_rep<k>.json, diffs/, errors.jsonl
#   <flow>/_state.json (metrics, perf_fields, harness sha)
#
# Runs bill the Claude subscription (OAuth). The runner refuses to start if an
# API key or auth token is in the environment, since either switches billing.
#
# Usage:
#   role_eval.rb run --variant baseline --model claude-opus-5-5 --effort medium \
#                --max-sessions N [--role coding-worker] [--reps 1] [--cases id,...] [--concurrency 2]
#   role_eval.rb selftest oracle|null [--cases id,...]
#   role_eval.rb summary [--role r] [--variant v]

require "digest"
require "fileutils"
require "json"
require "open3"
require "optparse"
require "tmpdir"

module RoleEval
  REPO = File.expand_path("..", __dir__)
  EVAL_DIR = File.join(REPO, "evals", "roles", "coding-worker")
  DEFAULT_ROLE = "coding-worker"
  MIRRORS = File.join(Dir.tmpdir, "autobots-role-eval-mirrors")
  HARNESS_PATHS = ["scripts/role_eval.rb", "evals/roles/coding-worker/cases.json",
                   "evals/roles/coding-worker/prompts", "evals/roles/coding-worker/hidden"].freeze
  BILLING_VARS = %w[ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL].freeze
  # Inputs that would override the arm's model or effort.
  STRIP_VARS = %w[CLAUDE_CODE_EFFORT_LEVEL CLAUDE_CODE_SUBAGENT_MODEL ANTHROPIC_MODEL].freeze
  QUOTA_RE = /usage limit|rate limit|session limit|limit reached|quota/i
  EFFORTS = %w[low medium high xhigh max].freeze
  EDIT_TOOLS = %w[Edit Write NotebookEdit].freeze
  # Test commands the case repos use (rake/minitest, bash test scripts).
  TEST_CMD_RE = /\brake\b.*\btest\b|-Itest\b|_test\.(rb|sh)\b|\btest\/\*/
  WRITE_CMD_RE = %r{\bsed\s+-i|\bperl\s+-\w*i|\.write\(|\bcat\s*>|\btee\b|\bgit\s+(apply|checkout|restore|stash)\b|
                    (?:^|[\s;&|])>{1,2}(?!\s*/dev/null)\s*[\w./~"'$]}x

  METRICS = [
    { "id" => "pass", "label" => "pass", "kind" => "binary" },
    { "id" => "hidden", "label" => "hidden test", "kind" => "binary" },
    { "id" => "suite", "label" => "repo suite", "kind" => "binary" },
    { "id" => "scope", "label" => "in scope", "kind" => "binary" },
    { "id" => "changed", "label" => "not no-op", "kind" => "binary" }
  ].freeze
  PERF_FIELDS = [
    { "id" => "latency_s", "label" => "wall", "unit" => "s" },
    { "id" => "turns", "label" => "turns" },
    { "id" => "tool_calls", "label" => "tool calls" },
    { "id" => "api_equiv_usd", "label" => "API-equiv", "unit" => "$" },
    { "id" => "diff_lines", "label" => "diff lines" },
    { "id" => "diff_files", "label" => "diff files" }
  ].freeze

  WRITE_LOCK = Mutex.new

  Result = Struct.new(:out, :err, :code) do
    def ok? = code == 0
    def timed_out? = code.nil?
    def tail(n = 1500) = (out + err)[-n..] || (out + err)
  end

  module_function

  # ---------- setup ----------

  def flow_dir(role) = File.join(REPO, "evals", "roles", role, "runs")
  def role_file(role) = File.join(REPO, ".claude", "agents", "#{role}.md")

  def die(msg, code = 1)
    warn "role_eval: #{msg}"
    exit code
  end

  # Env overrides for child processes: unset the vars that would change the arm.
  def check_env
    bad = BILLING_VARS.select { |v| ENV[v] && !ENV[v].empty? }
    die("refusing to run: #{bad.join(', ')} set; runs must bill the subscription, not the API") if bad.any?
    STRIP_VARS.to_h { |v| [v, nil] }
  end

  def harness_sha
    h = Digest::SHA256.new
    HARNESS_PATHS.each do |rel|
      p = File.join(REPO, rel)
      files = File.directory?(p) ? Dir.glob("**/*", File::FNM_DOTMATCH, base: p).map { |f| File.join(p, f) }.select { |f| File.file?(f) }.sort : [p]
      files.each do |f|
        h << f.delete_prefix("#{REPO}/")
        h << File.binread(f)
      end
    end
    h.hexdigest
  end

  def load_state(flow)
    p = File.join(flow, "_state.json")
    File.exist?(p) ? JSON.parse(File.read(p)) : {}
  end

  def gate_harness(approve, flow)
    state = load_state(flow)
    sha = harness_sha
    if approve
      state.merge!("metrics" => METRICS, "perf_fields" => PERF_FIELDS,
                   "harness_paths" => HARNESS_PATHS, "harness_sha" => sha)
      FileUtils.mkdir_p(flow)
      File.write(File.join(flow, "_state.json"), "#{JSON.pretty_generate(state)}\n")
      puts "harness approved: #{sha[0, 12]}"
    elsif state["harness_sha"] != sha
      die("harness changed since last approval (runner, cases, prompts or hidden tests); " \
          "the owner must re-run with --approve-harness", 2)
    end
  end

  def load_cases(only)
    cases = JSON.parse(File.read(File.join(EVAL_DIR, "cases.json")))["cases"]
    return cases unless only

    want = only.split(",")
    missing = want - cases.map { |c| c["id"] }
    die("unknown case ids: #{missing.sort}") if missing.any?
    cases.select { |c| want.include?(c["id"]) }
  end

  # Runs cmd (argv array, or a string for the shell) with a timeout; kills the
  # whole process group when it fires; the Result then has a nil code.
  def sh(cmd, cwd, timeout_s, env = {}, stdin: nil)
    argv = cmd.is_a?(String) ? ["/bin/sh", "-c", cmd] : cmd
    Open3.popen3(env, *argv, chdir: cwd.to_s, pgroup: true) do |i, o, e, wait|
      # Readers start before the stdin write, so a chatty child can't deadlock us.
      out = Thread.new { o.read }
      err = Thread.new { e.read }
      begin
        i.write(stdin) if stdin
      rescue Errno::EPIPE
        # The child exited without reading all of stdin; its exit code tells the story.
      end
      i.close
      unless wait.join(timeout_s)
        Process.kill("KILL", -wait.pid)
        wait.join
        return Result.new(out.value, err.value, nil)
      end
      Result.new(out.value, err.value, wait.value.exitstatus || 1)
    end
  end

  def run!(*cmd, cwd: REPO, timeout_s: 600)
    r = sh(cmd, cwd, timeout_s)
    raise "#{cmd.join(' ')} failed: #{r.err}" unless r.ok?

    r.out
  end

  def mirror_for(repo)
    File.join(MIRRORS, repo.gsub(/[^A-Za-z0-9]+/, "_"))
  end

  # Clones the case's base commit into a fresh temp dir. Returns [dir, base sha].
  def make_workspace(c)
    FileUtils.mkdir_p(MIRRORS)
    mirror = mirror_for(c["repo"])
    WRITE_LOCK.synchronize do
      unless File.exist?(mirror)
        # Clone beside the mirror and rename, so a killed clone never leaves a partial mirror.
        partial = "#{mirror}.partial"
        FileUtils.rm_rf(partial)
        run!("git", "clone", "-q", "--mirror", c["repo"], partial, timeout_s: 3600)
        File.rename(partial, mirror)
      end
    end
    base = run!("git", "--git-dir=#{mirror}", "rev-parse", "#{c['base']}^{commit}").strip
    # Neutral name: the path is visible to the agent.
    ws = File.join(Dir.mktmpdir("role-eval-"), "repo")
    # Fetch only history reachable from base, with no remote left behind, so the
    # accepted fix (a later commit) is not in the workspace's object store.
    run!("git", "init", "-q", ws)
    run!("git", "-C", ws, "-c", "protocol.version=2", "fetch", "-q", "--no-tags", "file://#{mirror}", base)
    run!("git", "-C", ws, "checkout", "-q", "-B", "main", base)
    [ws, base]
  end

  def pin_role(ws, role, model, effort)
    text = File.read(role_file(role)).sub(/^model:.*$/, "model: #{model}").sub(/^effort:.*$/, "effort: #{effort}")
    dest = File.join(ws, ".claude", "agents", "#{role}.md")
    FileUtils.mkdir_p(File.dirname(dest))
    File.write(dest, text)
    File.open(File.join(ws, ".git", "info", "exclude"), "a") { |f| f.write("\n/.claude/agents/#{role}.md\n") }
  end

  # ---------- agent run ----------

  def run_agent(ws, role, prompt, effort, env, timeout_s, max_turns)
    cmd = ["claude", "-p", "--agent", role, "--effort", effort,
           "--output-format", "stream-json", "--verbose",
           "--permission-mode", "auto", "--no-session-persistence",
           "--max-turns", max_turns.to_s, prompt]
    t0 = Process.clock_gettime(Process::CLOCK_MONOTONIC)
    r = sh(cmd, ws, timeout_s, env)
    wall = Process.clock_gettime(Process::CLOCK_MONOTONIC) - t0
    { timeout: r.timed_out?, wall_s: wall, events: parse_events(r.out), returncode: r.code, stderr: r.err[-2000..] || r.err }
  end

  def parse_events(out)
    out.each_line.filter_map do |line|
      JSON.parse(line)
    rescue JSON::ParserError
      nil
    end
  end

  # Stream-json events to build-eval Turn[] plus a tool-call count.
  def to_trace(events)
    trace = []
    tools = 0
    events.each do |ev|
      t = ev["type"]
      if t == "system" && ev["subtype"] == "init"
        trace << { "role" => "system", "content" => "init: model=#{ev['model']} " \
                   "apiKeySource=#{ev['apiKeySource']} permissionMode=#{ev['permissionMode']}" }
      elsif %w[assistant user].include?(t)
        content = ev.dig("message", "content") || []
        if content.is_a?(String)
          trace << { "role" => t, "content" => content }
          next
        end
        thinking = nil
        with_thinking = ->(turn) { thinking.to_s.empty? ? turn : turn.merge("thinking" => thinking) }
        content.each do |c|
          case c["type"]
          when "thinking"
            thinking = c.fetch("thinking", "")
          when "text"
            trace << with_thinking.({ "role" => t, "content" => c.fetch("text", "") })
            thinking = nil
          when "tool_use"
            tools += 1
            trace << with_thinking.({ "role" => "tool_call", "name" => c["name"],
                                      "content" => JSON.pretty_generate(c["input"]) })
            thinking = nil
          when "tool_result"
            body = c["content"]
            body = body.select { |x| x.is_a?(Hash) }.map { |x| x.fetch("text", "") }.join("\n") if body.is_a?(Array)
            trace << { "role" => "tool_result", "content" => body.to_s }
          end
        end
      end
    end
    [trace, tools]
  end

  # 1 if a test command ran after the agent's last file edit, 0 if not, nil if
  # it edited nothing. Edits are Edit/Write/NotebookEdit calls and Bash calls
  # that look like writes (sed -i, heredoc writes, redirects) outside a mktemp
  # scratch dir; one Bash call that writes and then tests counts as verified.
  # A heuristic, not a grade.
  def verified(trace)
    edited = pending = false
    trace.each do |t|
      next unless t["role"] == "tool_call"

      cmd = t["name"] == "Bash" ? (JSON.parse(t["content"])["command"] rescue nil).to_s : nil
      bash_write = cmd && WRITE_CMD_RE.match?(cmd) && !cmd.include?("mktemp")
      edited = pending = true if EDIT_TOOLS.include?(t["name"]) || bash_write
      pending = false if cmd && TEST_CMD_RE.match?(cmd)
    end
    return nil unless edited

    pending ? 0 : 1
  end

  # ---------- grading ----------

  def changed_paths(ws, base)
    tracked = sh(["git", "diff", "--name-only", base], ws, 60).out.split("\n")
    untracked = sh(["git", "ls-files", "--others", "--exclude-standard"], ws, 60).out.split("\n")
    (tracked + untracked).reject(&:empty?).uniq.sort
  end

  # Rules are path prefixes that are off-limits; "!prefix" means everything
  # outside prefix is off-limits.
  def out_of_scope(paths, offlimits)
    paths.select do |p|
      offlimits.any? { |rule| rule.start_with?("!") ? !p.start_with?(rule[1..]) : p.start_with?(rule) }
    end
  end

  def snapshot_diff(ws, base)
    sh(["git", "add", "-A", "-N"], ws, 60)
    diff = sh(["git", "diff", base], ws, 60).out
    numstat = sh(["git", "diff", "--numstat", base], ws, 60).out
    lines = numstat.each_line.sum do |l|
      a, d = l.split("\t")
      a.match?(/\A\d+\z/) && d.match?(/\A\d+\z/) ? a.to_i + d.to_i : 0
    end
    [diff, lines]
  end

  def grade(c, ws, base, env)
    paths = changed_paths(ws, base)
    bad = out_of_scope(paths, c["offlimits"])
    diff, lines = snapshot_diff(ws, base)
    # Suite before the hidden test lands, so the hidden file isn't part of it.
    # A grading timeout raises: the attempt becomes a harness error, never a score.
    run_graded = ->(cmd) { sh(cmd, ws, 900, env).tap { |r| raise "grading command timed out: #{cmd}" if r.timed_out? } }
    suite = run_graded.(c["suite"])
    # One rerun absorbs an intermittent suite failure seen at base in self-test;
    # a break the agent caused fails both times. Recorded as suite_flaky.
    first_suite_tail = nil
    unless suite.ok?
      first_suite_tail = suite.tail
      suite = run_graded.(c["suite"])
    end
    hidden = run_graded.(["bash", File.join(EVAL_DIR, c["hidden"]), ws])
    g = { "hidden" => hidden.ok? ? 1 : 0, "suite" => suite.ok? ? 1 : 0,
          "scope" => bad.empty? ? 1 : 0, "changed" => paths.empty? ? 0 : 1 }
    g = { "pass" => g.values.all?(1) ? 1 : 0 }.merge(g)
    detail = { "changed_paths" => paths, "out_of_scope" => bad, "diff" => diff, "diff_lines" => lines,
               "suite_tail" => suite.tail,
               "suite_flaky" => !first_suite_tail.nil? && suite.ok?,
               "first_suite_tail" => first_suite_tail,
               "hidden_tail" => hidden.tail }
    [g, detail]
  end

  # ---------- one attempt ----------

  def done_keys(vdir)
    p = File.join(vdir, "results.jsonl")
    return [] unless File.exist?(p)

    File.readlines(p, chomp: true).reject(&:empty?).map { |l| JSON.parse(l).values_at("prompt_id", "rep") }
  end

  def append(path, row)
    WRITE_LOCK.synchronize do
      FileUtils.mkdir_p(File.dirname(path))
      File.open(path, "a") { |f| f.puts(JSON.generate(row)) }
    end
  end

  # Hard cap on agent sessions across threads; stop halts everything.
  class Budget
    def initialize(n)
      @left = n
      @lock = Mutex.new
      @stop = false
    end

    def take
      @lock.synchronize do
        return false if @left <= 0 || @stop

        @left -= 1
        true
      end
    end

    def stop! = @lock.synchronize { @stop = true }
    def stopped? = @lock.synchronize { @stop }
  end

  def backoff(try_no) = sleep(rand(5.0..15.0) * try_no)

  def attempt(c, rep, opts, env, vdir, budget)
    errors = File.join(vdir, "errors.jsonl")
    (1..opts[:retries] + 1).each do |try_no|
      return unless budget.take

      ws = nil
      begin
        prompt = File.read(File.join(EVAL_DIR, c["prompt"]))
        ws, base = make_workspace(c)
        pin_role(ws, opts[:role], opts[:model], opts[:effort])
        run = run_agent(ws, opts[:role], prompt, opts[:effort], env, opts[:timeout_s], opts[:max_turns])
        result = run[:events].reverse.find { |e| e["type"] == "result" }
        init = run[:events].find { |e| e["type"] == "system" && e["subtype"] == "init" } || {}
        err_base = { "prompt_id" => c["id"], "rep" => rep, "attempt" => try_no, "wall_s" => run[:wall_s].round(1) }
        if run[:timeout]
          append(errors, err_base.merge("class" => "timeout"))
          return # ceiling fired: no retry
        end
        if result.nil?
          append(errors, err_base.merge("class" => "harness", "stderr" => run[:stderr]))
          backoff(try_no)
          next
        end
        usage_models = result["modelUsage"] || {}
        unless [nil, "none"].include?(init["apiKeySource"])
          budget.stop!
          append(errors, err_base.merge("class" => "billing", "apiKeySource" => init["apiKeySource"]))
          return
        end
        if result["is_error"] && QUOTA_RE.match?(result["result"].to_s)
          budget.stop!
          append(errors, err_base.merge("class" => "quota", "result" => result["result"].to_s[0, 300],
                                        "modelUsage" => usage_models))
          return
        end
        main = usage_models.max_by { |_, u| u.fetch("outputTokens", 0) }&.first
        if main != opts[:model]
          append(errors, err_base.merge("class" => "served_model_mismatch",
                                        "requested" => opts[:model], "modelUsage" => usage_models))
          return
        end
        if result["is_error"] && result["subtype"] != "error_max_turns"
          append(errors, err_base.merge("class" => "harness", "subtype" => result["subtype"],
                                        "result" => result["result"].to_s[0, 300], "modelUsage" => usage_models))
          backoff(try_no)
          next
        end
        trace, tool_calls = to_trace(run[:events])
        trace.insert(1, { "role" => "user", "content" => prompt })
        scores, detail = grade(c, ws, base, env)
        status = result["subtype"] == "error_max_turns" ? "truncated" : "ok"
        diff_path = File.join(vdir, "diffs", "#{c['id']}_rep#{rep}.patch")
        FileUtils.mkdir_p(File.dirname(diff_path))
        File.write(diff_path, detail["diff"])
        trace << { "role" => "system", "content" => "grader: #{JSON.pretty_generate(detail.except('diff'))}" }
        FileUtils.mkdir_p(File.join(vdir, "traces"))
        File.write(File.join(vdir, "traces", "#{c['id']}_rep#{rep}.json"), JSON.pretty_generate(trace))
        u = result["usage"] || {}
        append(File.join(vdir, "results.jsonl"), {
          "prompt_id" => c["id"], "rep" => rep, "prompt" => prompt, "tags" => c["tags"],
          "status" => status, "stop_reason" => result["subtype"],
          "grade" => status == "ok" ? scores : {},
          "model" => main, "models" => usage_models.keys.sort, "effort" => opts[:effort],
          "attempt" => try_no, "base_sha" => base,
          "latency_s" => ((result["duration_ms"] || 0) / 1000.0).round(1),
          "turns" => result["num_turns"], "tool_calls" => tool_calls, "verified" => verified(trace),
          "api_equiv_usd" => result["total_cost_usd"],
          "diff_lines" => detail["diff_lines"], "diff_files" => detail["changed_paths"].size,
          "usage" => %w[input_tokens output_tokens cache_read_input_tokens cache_creation_input_tokens]
            .to_h { |k| [k, u.fetch(k, 0)] },
          "meta" => { "changed_paths" => detail["changed_paths"], "out_of_scope" => detail["out_of_scope"],
                      "suite_flaky" => detail["suite_flaky"], "source" => c["source"] }
        })
        puts "#{c['id']} rep#{rep}: #{scores} #{status} #{run[:wall_s].round}s"
        return
      rescue StandardError => e # harness bug: record, never score
        append(errors, { "prompt_id" => c["id"], "rep" => rep, "attempt" => try_no,
                         "class" => "harness", "exception" => e.inspect[0, 500] })
        return
      ensure
        FileUtils.rm_rf(File.dirname(ws)) if ws && !opts[:keep]
      end
    end
  end

  # ---------- commands ----------

  def cmd_run(opts)
    env = check_env
    flow = flow_dir(opts[:role])
    gate_harness(opts[:approve_harness], flow)
    die("variant must be 'baseline' or 'v<N>'") unless opts[:variant].match?(/\A(baseline|v\d+)\z/)
    vdir = File.join(flow, opts[:variant])
    done = done_keys(vdir)
    todo = load_cases(opts[:cases]).product((0...opts[:reps]).to_a).reject { |c, r| done.include?([c["id"], r]) }
    puts "#{todo.size} attempts to run (#{done.size} already done); session cap #{opts[:max_sessions]}"
    budget = Budget.new(opts[:max_sessions])
    queue = Queue.new
    todo.each { |t| queue << t }
    queue.close
    Array.new(opts[:concurrency]) do
      Thread.new do
        while (item = queue.pop)
          begin
            attempt(*item, opts, env, vdir, budget)
          rescue StandardError => e # e.g. errors.jsonl unwritable: keep the other attempts alive
            warn "role_eval: #{item[0]['id']} rep#{item[1]}: #{e.inspect}"
          end
        end
      end
    end.each(&:join)
    warn "stopped early: quota or billing guard fired; see errors.jsonl" if budget.stopped?
    summarize(vdir)
  end

  # Grades oracle and null end states through the real grader, no model calls.
  def cmd_selftest(kind, opts)
    env = check_env
    oracles = kind == "oracle" ? JSON.parse(File.read(File.join(EVAL_DIR, "oracles.json"))) : {}
    bad = 0
    load_cases(opts[:cases]).each do |c|
      ws, base = make_workspace(c)
      begin
        if kind == "oracle"
          o = oracles.fetch(c["id"])
          if o["patch"]
            r = sh(["git", "apply", File.expand_path(File.join(EVAL_DIR, o["patch"]))], ws, 60)
          else
            patch = sh(["git", "--git-dir=#{mirror_for(c['repo'])}", "diff", "--binary", base, o["commit"],
                        "--", *o.fetch("paths", [])], ws, 120)
            r = patch.ok? ? sh(["git", "apply", "--index"], ws, 120, stdin: patch.out) : patch
          end
          raise "oracle did not apply for #{c['id']}: #{r.err}" unless r.ok?
        end
        scores, detail = grade(c, ws, base, env)
        ok = scores["pass"] == (kind == "oracle" ? 1 : 0)
        bad += 1 unless ok
        msg = "#{ok ? 'ok ' : 'BAD'} #{c['id']}: #{scores}"
        last = ->(s, n) { (s[-n..] || s).inspect }
        msg += "\n    hidden: #{last.(detail['hidden_tail'], 300)}\n    oob: #{detail['out_of_scope']}" unless ok
        msg += "\n    suite: #{last.(detail['suite_tail'], 600)}" if scores["suite"].zero?
        msg += "\n    flaky suite, first run: #{last.(detail['first_suite_tail'], 600)}" if detail["suite_flaky"]
        puts msg
      ensure
        FileUtils.rm_rf(File.dirname(ws))
      end
    end
    bad.zero? ? 0 : 1
  end

  def wilson(k, n, z = 1.96)
    return [0.0, 0.0] if n.zero?

    p = k.fdiv(n)
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * Math.sqrt(p * (1 - p) / n + z * z / (4.0 * n * n)) / d
    [[0.0, c - h].max, [1.0, c + h].min]
  end

  def summarize(vdir)
    read = ->(name) { (p = File.join(vdir, name)) && File.exist?(p) ? File.readlines(p, chomp: true).reject(&:empty?) : [] }
    rows = read.("results.jsonl").map { |l| JSON.parse(l) }
    ok = rows.select { |r| r["status"] == "ok" }
    k = ok.sum { |r| r["grade"]["pass"] }
    lo, hi = wilson(k, ok.size)
    usd = rows.sum { |r| r["api_equiv_usd"] || 0 }
    ver = ok.filter_map { |r| r["verified"] }
    pct = ->(x) { format("%.0f%%", x * 100) }
    puts "#{File.basename(vdir)}: pass #{k}/#{ok.size} = #{pct.(ok.empty? ? 0 : k.fdiv(ok.size))} " \
         "(95% Wilson #{pct.(lo)}-#{pct.(hi)}); truncated #{rows.size - ok.size}; " \
         "errors #{read.('errors.jsonl').size}; tested after last edit #{ver.sum}/#{ver.size}; API-equivalent usage $#{format('%.2f', usd)} (subscription; not billed)"
    0
  end

  def main(argv)
    cmd = argv.shift
    opts = { reps: 1, concurrency: 2, timeout_s: 1800, max_turns: 150, retries: 1,
             keep: false, approve_harness: false, role: DEFAULT_ROLE }
    parser = OptionParser.new do |o|
      o.banner = "usage: role_eval.rb run|selftest|summary [options]"
      o.on("--variant V") { |v| opts[:variant] = v }
      o.on("--cases IDS") { |v| opts[:cases] = v }
      o.on("--role R", "agent under test (default #{DEFAULT_ROLE})") { |v| opts[:role] = v }
      if cmd == "run"
        o.on("--model M", "full model ID; asserted against modelUsage") { |v| opts[:model] = v }
        o.on("--effort E", EFFORTS) { |v| opts[:effort] = v }
        o.on("--reps N", Integer) { |v| opts[:reps] = v }
        o.on("--max-sessions N", Integer, "hard cap on agent sessions, retries included") { |v| opts[:max_sessions] = v }
        o.on("--concurrency N", Integer) { |v| opts[:concurrency] = v }
        o.on("--timeout-s N", Integer) { |v| opts[:timeout_s] = v }
        o.on("--max-turns N", Integer) { |v| opts[:max_turns] = v }
        o.on("--retries N", Integer) { |v| opts[:retries] = v }
        o.on("--keep", "keep workspaces for debugging") { opts[:keep] = true }
        o.on("--approve-harness", "owner only") { opts[:approve_harness] = true }
      end
    end
    begin
      rest = parser.parse(argv)
    rescue OptionParser::ParseError => e
      die("#{e.message}\n#{parser.banner}")
    end
    die("unknown role: #{opts[:role]} (no #{role_file(opts[:role])})") unless File.file?(role_file(opts[:role]))
    case cmd
    when "run"
      missing = %i[model effort max_sessions].reject { |k| opts[k] }
      die("run: missing #{missing.map { |k| "--#{k.to_s.tr('_', '-')}" }.join(', ')}") if missing.any?
      die("run: missing --variant") unless opts[:variant]
      cmd_run(opts)
    when "selftest"
      die("selftest: kind must be oracle or null") unless rest.size == 1 && %w[oracle null].include?(rest.first)
      cmd_selftest(rest.first, opts)
    when "summary" then summarize(File.join(flow_dir(opts[:role]), opts[:variant] || "baseline"))
    else die(parser.banner)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  $stdout.sync = true
  exit RoleEval.main(ARGV)
end
