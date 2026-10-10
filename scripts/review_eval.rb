#!/usr/bin/env ruby
# frozen_string_literal: true

# Reviewer role eval: runs the reviewer headless on real diffs, some with
# planted bugs, and scores whether its findings land on them.
#
# Items live in evals/roles/reviewer/items.json. A planted item is a passing
# diff with bugs planted in lines it added; each bug has a witness script that
# exits non-zero while the bug is present. A clean item is an unmodified
# passing diff. For every (item, rep) the runner rebuilds the case's base
# commit, applies the item's patch uncommitted, pins the reviewer role with
# the arm's model and effort, and asks for a review that ends in a JSON list
# of findings. A bug is caught when a blocking or should-fix finding names its
# file and a line within SLACK lines of it.
#
# Output (build-eval layout, local only):
#   evals/roles/reviewer/runs/<variant>/results.jsonl, traces/, errors.jsonl
#   evals/roles/reviewer/runs/_state.json (harness sha)
#
# Usage:
#   review_eval.rb run --variant baseline --model claude-fable-5-1 --effort high \
#                  --max-sessions N [--reps 2] [--items id,...] [--concurrency 3]
#   review_eval.rb selftest [--items id,...]
#   review_eval.rb summary [--variant v]

require_relative "role_eval"

module ReviewEval
  DIR = File.join(RoleEval::REPO, "evals", "roles", "reviewer")
  FLOW = File.join(DIR, "runs")
  ROLE = "reviewer"
  # A finding within SLACK lines of a bug's range lands on it; a finding whose
  # range spans more than MAX_RANGE lines counts at its first line only.
  SLACK = 5
  MAX_RANGE = 20
  CATCH_SEVERITIES = %w[blocking should-fix].freeze
  SEVERITIES = %w[blocking should-fix nit].freeze
  HARNESS_PATHS = ["scripts/review_eval.rb", "scripts/role_eval.rb", "evals/roles/reviewer/items.json",
                   "evals/roles/reviewer/diffs", "evals/roles/reviewer/witnesses",
                   "evals/roles/coding-worker/cases.json", "evals/roles/coding-worker/prompts"].freeze
  FENCE = "`" * 3

  module_function

  # ---------- prompt and findings ----------

  def prompt(task)
    <<~PROMPT
      Review the uncommitted change in this repository before it ships. `git status` and `git diff` show it; new files are marked intent-to-add, so `git diff` includes them. A coding worker made the change for this task:

      <task>
      #{task.strip}
      </task>

      Review it as you normally would. Then end your reply with one fenced json block that lists every finding, most severe first, or `[]` if you have none:

      #{FENCE}json
      [{"file": "path/from/repo/root", "line": 123, "severity": "blocking|should-fix|nit", "summary": "one sentence"}]
      #{FENCE}

      `line` is the line number in the file as it is now in the working tree.
    PROMPT
  end

  # The last fenced json block, if it parses to a list of objects; else nil.
  def findings(text)
    block = text.to_s.scan(/^#{FENCE}json[ \t]*\n(.*?)^#{FENCE}/m).last&.first
    return nil unless block

    list = JSON.parse(block)
    list.is_a?(Array) && list.all?(Hash) ? list : nil
  rescue JSON::ParserError
    nil
  end

  # Repo-relative file, integer line range, and one of SEVERITIES (or the raw word).
  def normalize(f, ws)
    file = f["file"].to_s.strip
    [ws, (File.realpath(ws) rescue nil)].compact.uniq.each { |root| file = file.delete_prefix("#{root}/") }
    file = file.delete_prefix("./")
    line = f["line"]
    if (m = file.match(/:(\d+(?:-\d+)?)\z/))
      file = m.pre_match
      line ||= m[1]
    end
    lo, hi = line.to_s.scan(/\d+/).first(2).map(&:to_i)
    sev = f["severity"].to_s.strip.downcase
    sev = if SEVERITIES.include?(sev) then sev
          elsif sev.match?(/non-?block/) then sev
          elsif sev.include?("block") then "blocking"
          elsif sev.include?("should") then "should-fix"
          elsif sev.include?("nit") then "nit"
          else sev
          end
    f.merge("file" => file, "line" => lo, "line_end" => hi || lo, "severity" => sev)
  end

  # ---------- grading ----------

  def locations(bug) = [[bug["file"], bug["lines"]]] + Array(bug["alt"]).map { |a| [a["file"], a["lines"]] }

  def near?(f, file, (lo, hi))
    return false unless f["file"] == file && f["line"]

    f_lo = f["line"]
    f_hi = f["line_end"] || f_lo
    f_hi = f_lo if f_hi - f_lo > MAX_RANGE
    f_lo <= hi + SLACK && f_hi >= lo - SLACK
  end

  # fs is the normalized findings list, or nil when the reply had none (a
  # format error: every bug is missed).
  def grade(item, fs)
    list = fs || []
    bugs = item.fetch("bugs", [])
    matched = bugs.each_with_object({}) do |b, h|
      f = list.find { |x| CATCH_SEVERITIES.include?(x["severity"]) && locations(b).any? { |file, r| near?(x, file, r) } }
      h[b["id"]] = f["summary"] if f
    end
    count = ->(s) { list.count { |f| f["severity"] == s } }
    { "format_ok" => !fs.nil?, "findings" => list.size, "blocking" => count.("blocking"),
      "should_fix" => count.("should-fix"), "nits" => count.("nit"),
      "caught" => matched.keys, "missed" => bugs.map { |b| b["id"] } - matched.keys, "matched" => matched }
  end

  # File => new-side line numbers of the diff's added lines.
  def added_lines(diff)
    out = Hash.new { |h, k| h[k] = [] }
    file = nil
    n = 0
    diff.each_line(chomp: true) do |l|
      if l.start_with?("+++ ")
        file = l == "+++ /dev/null" ? nil : l.delete_prefix("+++ b/")
      elsif (m = l.match(/\A@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/))
        n = m[1].to_i
      elsif l.start_with?("+") && file
        out[file] << n
        n += 1
      elsif l.start_with?(" ")
        n += 1
      end
    end
    out.to_h
  end

  # ---------- setup ----------

  def load_items(only)
    items = JSON.parse(File.read(File.join(DIR, "items.json")))["items"]
    return items unless only

    want = only.split(",")
    missing = want - items.map { |i| i["id"] }
    RoleEval.die("unknown item ids: #{missing.sort}") if missing.any?
    items.select { |i| want.include?(i["id"]) }
  end

  def cases = JSON.parse(File.read(File.join(RoleEval::EVAL_DIR, "cases.json")))["cases"].to_h { |c| [c["id"], c] }

  # The case's base commit with patch applied, uncommitted; new files intent-to-add.
  def workspace(c, patch)
    ws, base = RoleEval.make_workspace(c)
    RoleEval.run!("git", "-C", ws, "apply", File.join(DIR, patch))
    RoleEval.run!("git", "-C", ws, "add", "-A", "-N")
    [ws, base]
  end

  # What a read-only reviewer must leave as it found it.
  def fingerprint(ws, base)
    Digest::SHA256.hexdigest(RoleEval.sh(["git", "status", "--porcelain", "--untracked-files=all"], ws, 60).out +
                             RoleEval.sh(["git", "diff", base], ws, 60).out)
  end

  # ---------- one attempt ----------

  def attempt(item, rep, opts, env, vdir, budget)
    errors = File.join(vdir, "errors.jsonl")
    (1..opts[:retries] + 1).each do |try_no|
      return unless budget.take

      ws = nil
      begin
        c = cases.fetch(item["case"])
        text = prompt(File.read(File.join(RoleEval::EVAL_DIR, c["prompt"])))
        ws, base = workspace(c, item["patch"])
        RoleEval.pin_role(ws, ROLE, opts[:model], opts[:effort])
        before = fingerprint(ws, base)
        run = RoleEval.run_agent(ws, ROLE, text, opts[:effort], env, opts[:timeout_s], opts[:max_turns])
        err_base = { "item" => item["id"], "rep" => rep, "attempt" => try_no, "wall_s" => run[:wall_s].round(1) }
        if (f = RoleEval.fault(run, opts[:model]))
          budget.stop! if f[:stop]
          RoleEval.append(errors, err_base.merge(f[:row]))
          return unless f[:retry]

          RoleEval.backoff(try_no)
          next
        end
        result = run[:result]
        fs = findings(result["result"])&.map { |f| normalize(f, ws) }
        g = grade(item, fs)
        status = result["subtype"] == "error_max_turns" ? "truncated" : "ok"
        trace, tool_calls = RoleEval.to_trace(run[:events])
        trace.insert(1, { "role" => "user", "content" => text })
        FileUtils.mkdir_p(File.join(vdir, "traces"))
        File.write(File.join(vdir, "traces", "#{item['id']}_rep#{rep}.json"), JSON.pretty_generate(trace))
        u = result["usage"] || {}
        RoleEval.append(File.join(vdir, "results.jsonl"), {
          "item" => item["id"], "case" => item["case"], "kind" => item["kind"], "rep" => rep,
          "status" => status, "stop_reason" => result["subtype"], "grade" => g, "findings" => fs,
          "mutated" => fingerprint(ws, base) != before,
          "model" => run[:model], "models" => run[:usage_models].keys.sort, "effort" => opts[:effort], "attempt" => try_no,
          "latency_s" => ((result["duration_ms"] || 0) / 1000.0).round(1), "wall_s" => run[:wall_s].round(1),
          "turns" => result["num_turns"], "tool_calls" => tool_calls, "api_equiv_usd" => result["total_cost_usd"],
          "usage" => %w[input_tokens output_tokens cache_read_input_tokens cache_creation_input_tokens]
            .to_h { |k| [k, u.fetch(k, 0)] }
        })
        puts "#{item['id']} rep#{rep}: caught #{g['caught'].size}/#{item.fetch('bugs', []).size} " \
             "blocking #{g['blocking']} format_ok #{g['format_ok']} #{status} #{run[:wall_s].round}s"
        return
      rescue StandardError => e # harness bug: record, never score
        RoleEval.append(errors, { "item" => item["id"], "rep" => rep, "attempt" => try_no,
                                  "class" => "harness", "exception" => e.inspect[0, 500] })
        return
      ensure
        FileUtils.rm_rf(File.dirname(ws)) if ws && !opts[:keep]
      end
    end
  end

  # ---------- commands ----------

  def cmd_run(opts)
    env = RoleEval.check_env
    RoleEval.gate_harness(opts[:approve_harness], FLOW, paths: HARNESS_PATHS)
    RoleEval.die("variant must be 'baseline' or 'v<N>'") unless opts[:variant].match?(/\A(baseline|v\d+)\z/)
    vdir = File.join(FLOW, opts[:variant])
    done = done_keys(vdir)
    todo = load_items(opts[:items]).product((0...opts[:reps]).to_a).reject { |i, r| done.include?([i["id"], r]) }
    puts "#{todo.size} attempts to run (#{done.size} already done); session cap #{opts[:max_sessions]}"
    budget = RoleEval::Budget.new(opts[:max_sessions])
    queue = Queue.new
    todo.each { |t| queue << t }
    queue.close
    Array.new(opts[:concurrency]) do
      Thread.new do
        while (t = queue.pop)
          begin
            attempt(*t, opts, env, vdir, budget)
          rescue StandardError => e
            warn "review_eval: #{t[0]['id']} rep#{t[1]}: #{e.inspect}"
          end
        end
      end
    end.each(&:join)
    warn "stopped early: quota or billing guard fired; see errors.jsonl" if budget.stopped?
    summarize(vdir)
  end

  def done_keys(vdir)
    p = File.join(vdir, "results.jsonl")
    return [] unless File.exist?(p)

    File.readlines(p, chomp: true).reject(&:empty?).map { |l| JSON.parse(l).values_at("item", "rep") }
  end

  # Checks every item without model calls: the patch applies at base and the
  # suite passes; each planted bug sits on added lines and its witness fails
  # there but passes on the item's source diff.
  def cmd_selftest(opts)
    env = RoleEval.check_env
    bad = 0
    load_items(opts[:items]).each do |item|
      c = cases.fetch(item["case"])
      problems = []
      ws, base = workspace(c, item["patch"])
      begin
        suite = RoleEval.sh(c["suite"], ws, 900, env)
        suite = RoleEval.sh(c["suite"], ws, 900, env) unless suite.ok?
        problems << "suite fails: #{suite.tail(300).inspect}" unless suite.ok?
        added = added_lines(RoleEval.sh(["git", "diff", base], ws, 60).out)
        item.fetch("bugs", []).each do |b|
          lo, hi = b["lines"]
          problems << "#{b['id']}: lines #{lo}-#{hi} of #{b['file']} are not all added lines" unless (lo..hi).all? { |n| added.fetch(b["file"], []).include?(n) }
          problems << "#{b['id']}: witness passes with the bug present" if witness(b, ws, env).ok?
        end
      ensure
        FileUtils.rm_rf(File.dirname(ws))
      end
      if item["source"]
        src, = workspace(c, item["source"])
        begin
          item.fetch("bugs", []).each do |b|
            r = witness(b, src, env)
            problems << "#{b['id']}: witness fails on the source diff: #{r.tail(300).inspect}" unless r.ok?
          end
        ensure
          FileUtils.rm_rf(File.dirname(src))
        end
      elsif item["kind"] == "planted"
        problems << "planted item has no source diff"
      end
      bad += 1 if problems.any?
      puts "#{problems.empty? ? 'ok ' : 'BAD'} #{item['id']} (#{item['kind']}, #{item.fetch('bugs', []).size} bugs)" +
           problems.map { |p| "\n    #{p}" }.join
    end
    bad.zero? ? 0 : 1
  end

  def witness(bug, ws, env) = RoleEval.sh(["bash", File.join(DIR, bug["witness"]), ws], ws, 120, env)

  def median(xs)
    s = xs.compact.sort
    return nil if s.empty?

    s.size.odd? ? s[s.size / 2] : (s[s.size / 2 - 1] + s[s.size / 2]) / 2.0
  end

  def summarize(vdir)
    read = ->(name) { (p = File.join(vdir, name)) && File.exist?(p) ? File.readlines(p, chomp: true).reject(&:empty?) : [] }
    rows = read.("results.jsonl").map { |l| JSON.parse(l) }
    difficulty = load_items(nil).flat_map { |i| i.fetch("bugs", []) }.to_h { |b| [b["id"], b["difficulty"]] }
    planted = rows.select { |r| r["kind"] == "planted" }
    clean = rows.select { |r| r["kind"] == "clean" }
    obs = planted.flat_map { |r| r["grade"]["caught"].map { |id| [id, 1] } + r["grade"]["missed"].map { |id| [id, 0] } }
    k = obs.sum(&:last)
    lo, hi = RoleEval.wilson(k, obs.size)
    pct = ->(x) { format("%.0f%%", x * 100) }
    by_diff = obs.group_by { |id, _| difficulty[id] }.map { |d, xs| "#{d} #{xs.sum(&:last)}/#{xs.size}" }.sort.join(", ")
    usd = rows.sum { |r| r["api_equiv_usd"] || 0 }
    puts "#{File.basename(vdir)}: caught #{k}/#{obs.size} = #{pct.(obs.empty? ? 0 : k.fdiv(obs.size))} " \
         "(95% Wilson #{pct.(lo)}-#{pct.(hi)}; #{by_diff}); " \
         "clean runs with a blocking finding #{clean.count { |r| r['grade']['blocking'].positive? }}/#{clean.size}; " \
         "format errors #{rows.count { |r| !r['grade']['format_ok'] }}; truncated #{rows.count { |r| r['status'] != 'ok' }}; " \
         "mutated #{rows.count { |r| r['mutated'] }}; errors #{read.('errors.jsonl').size}; " \
         "median wall #{median(rows.map { |r| r['wall_s'] })}s, turns #{median(rows.map { |r| r['turns'] })}; " \
         "API-equivalent usage $#{format('%.2f', usd)} (subscription; not billed)"
    obs.group_by(&:first).sort.each { |id, xs| puts "  #{id} (#{difficulty[id]}): #{xs.sum(&:last)}/#{xs.size}" }
    0
  end

  def main(argv)
    cmd = argv.shift
    opts = { reps: 2, concurrency: 3, timeout_s: 1800, max_turns: 150, retries: 1, keep: false, approve_harness: false }
    parser = OptionParser.new do |o|
      o.banner = "usage: review_eval.rb run|selftest|summary [options]"
      o.on("--variant V") { |v| opts[:variant] = v }
      o.on("--items IDS") { |v| opts[:items] = v }
      if cmd == "run"
        o.on("--model M", "full model ID; asserted against modelUsage") { |v| opts[:model] = v }
        o.on("--effort E", RoleEval::EFFORTS) { |v| opts[:effort] = v }
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
      parser.parse!(argv)
    rescue OptionParser::ParseError => e
      RoleEval.die("#{e.message}\n#{parser.banner}")
    end
    case cmd
    when "run"
      missing = %i[model effort max_sessions variant].reject { |k| opts[k] }
      RoleEval.die("run: missing #{missing.map { |k| "--#{k.to_s.tr('_', '-')}" }.join(', ')}") if missing.any?
      cmd_run(opts)
    when "selftest" then cmd_selftest(opts)
    when "summary" then summarize(File.join(FLOW, opts[:variant] || "baseline"))
    else RoleEval.die(parser.banner)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  $stdout.sync = true
  exit ReviewEval.main(ARGV)
end
