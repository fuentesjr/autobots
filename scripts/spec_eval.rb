#!/usr/bin/env ruby
# frozen_string_literal: true

# spec-test-writer role eval: runs the role headless on an implementation-free
# brief and grades the tests it leaves behind against known implementations.
#
# Cases live in evals/roles/spec-test-writer/cases.json. Each names a repo, a
# base commit, a brief with numbered stated behaviors, the paths the role may
# change, reference patches (independent implementations that satisfy the
# brief), and mutant patches (plausible wrong implementations, each violating
# one stated behavior, with a witness test proving it is killable). For every
# (case, rep) the runner clones base, pins the role, hands it the brief, then
# grades its diff:
#   scope   every changed path is under the case's test_paths
#   changed the diff is not empty
#   red     the suite fails on base plus the role's tests
#   green   the suite passes on base plus each reference plus the role's tests
#   kill    the suite fails on base plus each mutant plus the role's tests
# References and mutants are applied with test_paths excluded, so only the
# role's tests decide. A run passes when all five hold. A case with
# updates_existing_tests changes behavior that existing tests pin, so its
# references and mutants fail the base suite until the role rewrites them.
#
# Output (build-eval layout, local only):
#   evals/roles/spec-test-writer/runs/<variant>/results.jsonl, traces/, diffs/, errors.jsonl
#   evals/roles/spec-test-writer/runs/_state.json (harness sha)
#
# Usage:
#   spec_eval.rb run --variant baseline --model claude-sonnet-5-5 --effort high \
#                --max-sessions N [--reps 2] [--cases id,...] [--concurrency 3]
#   spec_eval.rb selftest [--cases id,...]
#   spec_eval.rb summary [--variant v]

require_relative "role_eval"

module SpecEval
  DIR = File.join(RoleEval::REPO, "evals", "roles", "spec-test-writer")
  FLOW = File.join(DIR, "runs")
  ROLE = "spec-test-writer"
  HARNESS_PATHS = ["scripts/spec_eval.rb", "scripts/role_eval.rb", "evals/roles/spec-test-writer/cases.json",
                   "evals/roles/spec-test-writer/briefs", "evals/roles/spec-test-writer/references",
                   "evals/roles/spec-test-writer/mutants", "evals/roles/spec-test-writer/witnesses"].freeze
  # Pre-registered gate: at least PASS_MIN of the runs pass and no case fails every rep.
  PASS_MIN = 17

  module_function

  # ---------- setup ----------

  def harness_sha
    h = Digest::SHA256.new
    HARNESS_PATHS.each do |rel|
      p = File.join(RoleEval::REPO, rel)
      files = File.directory?(p) ? Dir.glob("**/*", File::FNM_DOTMATCH, base: p).map { |f| File.join(p, f) }.select { |f| File.file?(f) }.sort : [p]
      files.each do |f|
        h << f.delete_prefix("#{RoleEval::REPO}/")
        h << File.binread(f)
      end
    end
    h.hexdigest
  end

  def gate_harness(approve)
    path = File.join(FLOW, "_state.json")
    state = File.exist?(path) ? JSON.parse(File.read(path)) : {}
    sha = harness_sha
    if approve
      FileUtils.mkdir_p(FLOW)
      File.write(path, "#{JSON.pretty_generate(state.merge('harness_paths' => HARNESS_PATHS, 'harness_sha' => sha))}\n")
      puts "harness approved: #{sha[0, 12]}"
    elsif state["harness_sha"] != sha
      RoleEval.die("harness changed since last approval (runner, cases, briefs, references, mutants or witnesses); " \
                   "the owner must re-run with --approve-harness", 2)
    end
  end

  def load_cases(only)
    cases = JSON.parse(File.read(File.join(DIR, "cases.json")))["cases"]
    return cases unless only

    want = only.split(",")
    missing = want - cases.map { |c| c["id"] }
    RoleEval.die("unknown case ids: #{missing.sort}") if missing.any?
    cases.select { |c| want.include?(c["id"]) }
  end

  def in_scope?(path, test_paths) = test_paths.any? { |t| path.start_with?(t) }

  # The working tree against base, new files included, binary-safe.
  def role_diff(ws, base)
    RoleEval.sh(["git", "add", "-A", "-N"], ws, 60)
    RoleEval.sh(["git", "diff", "--binary", base], ws, 60).out
  end

  # A fresh base workspace with patch (minus test paths) and then tests applied.
  # Yields the workspace; removes it afterwards.
  def with_variant(c, patch: nil, tests: nil)
    ws, base = RoleEval.make_workspace(c)
    if patch
      excludes = c["test_paths"].map { |t| "--exclude=#{t}*" }
      RoleEval.run!("git", "-C", ws, "apply", "--binary", *excludes, File.join(DIR, patch))
    end
    if tests && !tests.empty?
      r = RoleEval.sh(["git", "apply", "--binary"], ws, 60, stdin: tests)
      raise "role diff did not apply over #{patch}: #{r.err}" unless r.ok?
    end
    yield ws, base
  ensure
    FileUtils.rm_rf(File.dirname(ws)) if ws
  end

  # A grading timeout raises: the attempt becomes a harness error, never a score.
  def suite(c, ws, env)
    RoleEval.sh(c["suite"], ws, 900, env).tap { |r| raise "suite timed out: #{c['id']}" if r.timed_out? }
  end

  # One rerun absorbs an intermittent failure; a real break fails both times.
  def suite_green?(c, ws, env) = suite(c, ws, env).ok? || suite(c, ws, env).ok?

  # ---------- grading ----------

  def grade(c, ws, base, env)
    paths = RoleEval.changed_paths(ws, base)
    out = paths.reject { |p| in_scope?(p, c["test_paths"]) }
    g = { "scope" => out.empty? ? 1 : 0, "changed" => paths.empty? ? 0 : 1 }
    detail = { "changed_paths" => paths, "out_of_scope" => out, "diff" => role_diff(ws, base),
               "red_tail" => nil, "references_failed" => {}, "mutants_survived" => [] }
    # Out of scope or empty: the rest would grade a diff we already reject.
    unless g.values.all?(1)
      g.merge!("red" => nil, "green" => nil, "kill" => nil)
      return [{ "pass" => 0 }.merge(g), detail]
    end

    red = suite(c, ws, env)
    detail["red_tail"] = red.tail(600)
    g["red"] = red.ok? ? 0 : 1
    c["references"].each do |ref|
      with_variant(c, patch: ref, tests: detail["diff"]) do |v, _|
        r = suite(c, v, env)
        r = suite(c, v, env) unless r.ok?
        detail["references_failed"][ref] = r.tail(600) unless r.ok?
      end
    end
    g["green"] = detail["references_failed"].empty? ? 1 : 0
    c["mutants"].each do |m|
      with_variant(c, patch: m["patch"], tests: detail["diff"]) do |v, _|
        detail["mutants_survived"] << m["id"] if suite(c, v, env).ok?
      end
    end
    g["kill"] = detail["mutants_survived"].empty? ? 1 : 0
    [{ "pass" => g.values.all?(1) ? 1 : 0 }.merge(g), detail]
  end

  # ---------- one attempt ----------

  def attempt(c, rep, opts, env, vdir, budget)
    errors = File.join(vdir, "errors.jsonl")
    (1..opts[:retries] + 1).each do |try_no|
      return unless budget.take

      ws = nil
      begin
        prompt = File.read(File.join(DIR, c["brief"]))
        ws, base = RoleEval.make_workspace(c)
        RoleEval.pin_role(ws, ROLE, opts[:model], opts[:effort])
        run = RoleEval.run_agent(ws, ROLE, prompt, opts[:effort], env, opts[:timeout_s], opts[:max_turns])
        result = run[:events].reverse.find { |e| e["type"] == "result" }
        init = run[:events].find { |e| e["type"] == "system" && e["subtype"] == "init" } || {}
        err_base = { "case" => c["id"], "rep" => rep, "attempt" => try_no, "wall_s" => run[:wall_s].round(1) }
        if run[:timeout]
          RoleEval.append(errors, err_base.merge("class" => "timeout"))
          return
        end
        if result.nil?
          RoleEval.append(errors, err_base.merge("class" => "harness", "stderr" => run[:stderr]))
          RoleEval.backoff(try_no)
          next
        end
        usage_models = result["modelUsage"] || {}
        unless [nil, "none"].include?(init["apiKeySource"])
          budget.stop!
          RoleEval.append(errors, err_base.merge("class" => "billing", "apiKeySource" => init["apiKeySource"]))
          return
        end
        if result["is_error"] && RoleEval::QUOTA_RE.match?(result["result"].to_s)
          budget.stop!
          RoleEval.append(errors, err_base.merge("class" => "quota", "result" => result["result"].to_s[0, 300]))
          return
        end
        main = usage_models.max_by { |_, u| u.fetch("outputTokens", 0) }&.first
        if main != opts[:model]
          RoleEval.append(errors, err_base.merge("class" => "served_model_mismatch",
                                                 "requested" => opts[:model], "modelUsage" => usage_models))
          return
        end
        if result["is_error"] && result["subtype"] != "error_max_turns"
          RoleEval.append(errors, err_base.merge("class" => "harness", "subtype" => result["subtype"],
                                                 "result" => result["result"].to_s[0, 300]))
          RoleEval.backoff(try_no)
          next
        end
        status = result["subtype"] == "error_max_turns" ? "truncated" : "ok"
        g, detail = grade(c, ws, base, env)
        # Truncated runs count as fail (pre-registered).
        g = g.merge("pass" => 0) if status != "ok"
        FileUtils.mkdir_p(File.join(vdir, "diffs"))
        File.write(File.join(vdir, "diffs", "#{c['id']}_rep#{rep}.patch"), detail["diff"])
        trace, tool_calls = RoleEval.to_trace(run[:events])
        trace.insert(1, { "role" => "user", "content" => prompt })
        trace << { "role" => "system", "content" => "grader: #{JSON.pretty_generate(detail.except('diff'))}" }
        FileUtils.mkdir_p(File.join(vdir, "traces"))
        File.write(File.join(vdir, "traces", "#{c['id']}_rep#{rep}.json"), JSON.pretty_generate(trace))
        u = result["usage"] || {}
        RoleEval.append(File.join(vdir, "results.jsonl"), {
          "case" => c["id"], "rep" => rep, "status" => status, "stop_reason" => result["subtype"], "grade" => g,
          "changed_paths" => detail["changed_paths"], "out_of_scope" => detail["out_of_scope"],
          "references_failed" => detail["references_failed"].keys, "mutants_survived" => detail["mutants_survived"],
          "model" => main, "models" => usage_models.keys.sort, "effort" => opts[:effort], "attempt" => try_no,
          "base_sha" => base, "latency_s" => ((result["duration_ms"] || 0) / 1000.0).round(1),
          "wall_s" => run[:wall_s].round(1), "turns" => result["num_turns"], "tool_calls" => tool_calls,
          "api_equiv_usd" => result["total_cost_usd"],
          "usage" => %w[input_tokens output_tokens cache_read_input_tokens cache_creation_input_tokens]
            .to_h { |k| [k, u.fetch(k, 0)] }
        })
        puts "#{c['id']} rep#{rep}: #{g} #{status} #{run[:wall_s].round}s"
        return
      rescue StandardError => e # harness bug: record, never score
        RoleEval.append(errors, { "case" => c["id"], "rep" => rep, "attempt" => try_no,
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
    gate_harness(opts[:approve_harness])
    RoleEval.die("variant must be 'baseline', 'smoke' or 'v<N>'") unless opts[:variant].match?(/\A(baseline|smoke|v\d+)\z/)
    vdir = File.join(FLOW, opts[:variant])
    done = done_keys(vdir)
    todo = load_cases(opts[:cases]).product((0...opts[:reps]).to_a).reject { |c, r| done.include?([c["id"], r]) }
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
            warn "spec_eval: #{t[0]['id']} rep#{t[1]}: #{e.inspect}"
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

    File.readlines(p, chomp: true).reject(&:empty?).map { |l| JSON.parse(l).values_at("case", "rep") }
  end

  def witness(c, m, ws, env) = RoleEval.sh(["bash", File.join(DIR, m["witness"]), ws], ws, 300, env)

  # Checks every case without model calls: the suite is green at base and on
  # every reference and mutant (unless the case updates existing tests);
  # references and mutants change production files
  # only; each mutant differs from every reference; each witness fails at base
  # and on its mutant but passes on every reference; an empty diff fails.
  def cmd_selftest(opts)
    env = RoleEval.check_env
    bad = 0
    load_cases(opts[:cases]).each do |c|
      problems = []
      with_variant(c) do |ws, base|
        problems << "suite fails at base" unless suite_green?(c, ws, env)
        c["mutants"].each { |m| problems << "#{m['id']}: witness passes at base" if witness(c, m, ws, env).ok? }
        g, = grade(c, ws, base, env)
        problems << "empty diff passes" unless g["pass"].zero?
      end
      refs = {}
      c["references"].each do |ref|
        with_variant(c, patch: ref) do |ws, base|
          paths = RoleEval.changed_paths(ws, base)
          problems << "#{ref}: changes nothing outside test paths" if paths.empty?
          problems << "#{ref}: test paths not excluded: #{paths.select { |p| in_scope?(p, c['test_paths']) }}" if paths.any? { |p| in_scope?(p, c["test_paths"]) }
          problems << "#{ref}: suite fails" unless c["updates_existing_tests"] || suite_green?(c, ws, env)
          c["mutants"].each do |m|
            r = witness(c, m, ws, env)
            problems << "#{m['id']}: witness fails on #{ref}: #{r.tail(200).inspect}" unless r.ok?
          end
          refs[ref] = RoleEval.sh(["git", "diff", base], ws, 60).out
        end
      end
      c["mutants"].each do |m|
        with_variant(c, patch: m["patch"]) do |ws, base|
          paths = RoleEval.changed_paths(ws, base)
          problems << "#{m['id']}: touches test paths" if paths.any? { |p| in_scope?(p, c["test_paths"]) }
          problems << "#{m['id']}: suite fails" unless c["updates_existing_tests"] || suite_green?(c, ws, env)
          problems << "#{m['id']}: witness passes on the mutant" if witness(c, m, ws, env).ok?
          diff = RoleEval.sh(["git", "diff", base], ws, 60).out
          same = refs.select { |_, d| d == diff }.keys
          problems << "#{m['id']}: identical to #{same}" if same.any?
        end
      end
      bad += 1 if problems.any?
      puts "#{problems.empty? ? 'ok ' : 'BAD'} #{c['id']} (#{c['references'].size} refs, #{c['mutants'].size} mutants)" +
           problems.map { |p| "\n    #{p}" }.join
    end
    bad.zero? ? 0 : 1
  end

  def median(xs)
    s = xs.compact.sort
    return nil if s.empty?

    s.size.odd? ? s[s.size / 2] : (s[s.size / 2 - 1] + s[s.size / 2]) / 2.0
  end

  # Per-case pass counts and the pre-registered verdict.
  def verdict(rows)
    by_case = rows.group_by { |r| r["case"] }.transform_values { |rs| [rs.sum { |r| r["grade"]["pass"] }, rs.size] }
    passes = by_case.values.sum(&:first)
    zero = by_case.select { |_, (k, n)| k.zero? && n.positive? }.keys.sort
    { "passes" => passes, "runs" => rows.size, "by_case" => by_case, "zero_cases" => zero,
      "certified" => passes >= PASS_MIN && zero.empty? }
  end

  def summarize(vdir)
    read = ->(name) { (p = File.join(vdir, name)) && File.exist?(p) ? File.readlines(p, chomp: true).reject(&:empty?) : [] }
    rows = read.("results.jsonl").map { |l| JSON.parse(l) }
    v = verdict(rows)
    lo, hi = RoleEval.wilson(v["passes"], rows.size)
    pct = ->(x) { format("%.0f%%", x * 100) }
    fails = %w[scope changed red green kill].map { |k| "#{k} #{rows.count { |r| r['grade'][k] == 0 }}" }.join(", ")
    usd = rows.sum { |r| r["api_equiv_usd"] || 0 }
    puts "#{File.basename(vdir)}: pass #{v['passes']}/#{rows.size} = #{pct.(rows.empty? ? 0 : v['passes'].fdiv(rows.size))} " \
         "(95% Wilson #{pct.(lo)}-#{pct.(hi)}); failed checks: #{fails}; " \
         "truncated #{rows.count { |r| r['status'] != 'ok' }}; errors #{read.('errors.jsonl').size}; " \
         "median wall #{median(rows.map { |r| r['wall_s'] })}s, turns #{median(rows.map { |r| r['turns'] })}; " \
         "API-equivalent usage $#{format('%.2f', usd)} (subscription; not billed)"
    v["by_case"].sort.each do |id, (k, n)|
      rs = rows.select { |r| r["case"] == id }
      notes = rs.flat_map { |r| r["references_failed"] + r["mutants_survived"] + r["out_of_scope"] }.uniq
      puts "  #{id}: #{k}/#{n}#{notes.empty? ? '' : "  (#{notes.join(', ')})"}"
    end
    puts "verdict: #{v['certified'] ? 'CERTIFIED' : 'NOT CERTIFIED'} (gate: >= #{PASS_MIN} passes and no case at 0; " \
         "zero cases: #{v['zero_cases'].empty? ? 'none' : v['zero_cases'].join(', ')})"
    0
  end

  def main(argv)
    cmd = argv.shift
    opts = { reps: 2, concurrency: 3, timeout_s: 1800, max_turns: 150, retries: 1, keep: false, approve_harness: false }
    parser = OptionParser.new do |o|
      o.banner = "usage: spec_eval.rb run|selftest|summary [options]"
      o.on("--variant V") { |v| opts[:variant] = v }
      o.on("--cases IDS") { |v| opts[:cases] = v }
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
  exit SpecEval.main(ARGV)
end
