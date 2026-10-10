#!/usr/bin/env ruby
# frozen_string_literal: true

# helper-worker role eval: runs the role headless on a read-only
# reconnaissance question about a pinned repo and grades its final message.
#
# Cases live in evals/roles/helper-worker/cases.json. Each names a repo, a base
# commit, a question phrased like a parent dispatch, the facts a correct answer
# must state (each a list of acceptable regexes), and regexes for known wrong
# answers. For every (case, rep) the runner clones base, pins the role, asks
# the question, then grades:
#   facts      every required fact matches at least one of its alternatives
#   clean      no must_not_include pattern matches
#   read_only  the workspace is untouched: `git status --porcelain` is empty
#              and HEAD is still the base commit
# A run passes when all three hold. Grading is deterministic; no LLM judge.
# Wall time, turns, tool calls, tokens and API-equivalent cost are recorded, not gated.
#
# Output (build-eval layout, local only):
#   evals/roles/helper-worker/runs/<variant>/results.jsonl, traces/, errors.jsonl
#   evals/roles/helper-worker/runs/_state.json (harness sha)
#
# Usage:
#   helper_eval.rb run --variant baseline --model claude-sonnet-5-5 --effort low \
#                  --max-sessions N [--reps 3] [--cases id,...] [--concurrency 3]
#   helper_eval.rb selftest [--cases id,...]
#   helper_eval.rb summary [--variant v]

require_relative "role_eval"

module HelperEval
  DIR = File.join(RoleEval::REPO, "evals", "roles", "helper-worker")
  FLOW = File.join(DIR, "runs")
  ROLE = "helper-worker"
  HARNESS_PATHS = ["scripts/helper_eval.rb", "scripts/role_eval.rb", "evals/roles/helper-worker/cases.json"].freeze
  NULL_ANSWER = "I could not determine this."
  CHECKS = %w[facts clean read_only].freeze

  module_function

  # ---------- setup ----------

  def load_cases(only)
    cases = JSON.parse(File.read(File.join(DIR, "cases.json")))["cases"]
    return cases unless only

    want = only.split(",")
    missing = want - cases.map { |c| c["id"] }
    RoleEval.die("unknown case ids: #{missing.sort}") if missing.any?
    cases.select { |c| want.include?(c["id"]) }
  end

  # ---------- grading ----------

  # Grades the answer text alone. Returns [checks, detail].
  def grade_answer(c, text)
    text = text.to_s
    missing = c["must_include"].reject { |f| f["any"].any? { |re| Regexp.new(re).match?(text) } }.map { |f| f["fact"] }
    hits = c["must_not_include"].select { |re| Regexp.new(re).match?(text) }
    [{ "facts" => missing.empty? ? 1 : 0, "clean" => hits.empty? ? 1 : 0 },
     { "missing_facts" => missing, "forbidden_hits" => hits }]
  end

  # What the role left behind: porcelain status lines (untracked files listed
  # individually) plus a note if HEAD moved. The pinned role file is excluded
  # via .git/info/exclude, so a clean run returns [].
  def workspace_changes(ws, base)
    status = RoleEval.sh(["git", "status", "--porcelain", "--untracked-files=all"], ws, 60)
    raise "git status failed: #{status.err}" unless status.ok?

    head = RoleEval.sh(["git", "rev-parse", "HEAD"], ws, 60).out.strip
    status.out.split("\n").reject(&:empty?) + (head == base ? [] : ["HEAD moved: #{base[0, 12]} -> #{head[0, 12]}"])
  end

  def grade(c, text, changes)
    g, detail = grade_answer(c, text)
    g["read_only"] = changes.empty? ? 1 : 0
    [{ "pass" => g.values.all?(1) ? 1 : 0 }.merge(g), detail.merge("workspace_changes" => changes)]
  end

  # ---------- one attempt ----------

  def attempt(c, rep, opts, env, vdir, budget)
    errors = File.join(vdir, "errors.jsonl")
    (1..opts[:retries] + 1).each do |try_no|
      return unless budget.take

      ws = nil
      begin
        prompt = c["prompt"]
        ws, base = RoleEval.make_workspace(c)
        RoleEval.pin_role(ws, ROLE, opts[:model], opts[:effort])
        run = RoleEval.run_agent(ws, ROLE, prompt, opts[:effort], env, opts[:timeout_s], opts[:max_turns])
        err_base = { "case" => c["id"], "rep" => rep, "attempt" => try_no, "wall_s" => run[:wall_s].round(1) }
        if (f = RoleEval.fault(run, opts[:model]))
          budget.stop! if f[:stop]
          RoleEval.append(errors, err_base.merge(f[:row]))
          return unless f[:retry]

          RoleEval.backoff(try_no)
          next
        end
        result = run[:result]
        status = result["subtype"] == "error_max_turns" ? "truncated" : "ok"
        answer = status == "ok" ? result["result"].to_s : ""
        g, detail = grade(c, answer, workspace_changes(ws, base))
        # Truncated runs count as fail (pre-registered).
        g = g.merge("pass" => 0) if status != "ok"
        trace, tool_calls = RoleEval.to_trace(run[:events])
        trace.insert(1, { "role" => "user", "content" => prompt })
        trace << { "role" => "system", "content" => "grader: #{JSON.pretty_generate(detail)}" }
        FileUtils.mkdir_p(File.join(vdir, "traces"))
        File.write(File.join(vdir, "traces", "#{c['id']}_rep#{rep}.json"), JSON.pretty_generate(trace))
        u = result["usage"] || {}
        RoleEval.append(File.join(vdir, "results.jsonl"), {
          "case" => c["id"], "kind" => c["kind"], "rep" => rep, "status" => status,
          "stop_reason" => result["subtype"], "grade" => g,
          "missing_facts" => detail["missing_facts"], "forbidden_hits" => detail["forbidden_hits"],
          "workspace_changes" => detail["workspace_changes"], "answer" => answer,
          "model" => run[:model], "models" => run[:usage_models].keys.sort, "effort" => opts[:effort], "attempt" => try_no,
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
    RoleEval.gate_harness(opts[:approve_harness], FLOW, paths: HARNESS_PATHS)
    RoleEval.die("variant must be a lowercase slug, e.g. baseline or haiku-low") unless opts[:variant].match?(/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/)
    vdir = File.join(FLOW, opts[:variant])
    arms = read_rows(vdir).map { |r| [r["model"], r["effort"]] }.uniq - [[opts[:model], opts[:effort]]]
    RoleEval.die("variant #{opts[:variant]} already holds runs of #{arms.map { |a| a.join('/') }.join(', ')}") if arms.any?
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
            warn "helper_eval: #{t[0]['id']} rep#{t[1]}: #{e.inspect}"
          end
        end
      end
    end.each(&:join)
    warn "stopped early: quota or billing guard fired; see errors.jsonl" if budget.stopped?
    summarize(vdir)
  end

  def read_rows(vdir)
    p = File.join(vdir, "results.jsonl")
    File.exist?(p) ? File.readlines(p, chomp: true).reject(&:empty?).map { |l| JSON.parse(l) } : []
  end

  def done_keys(vdir) = read_rows(vdir).map { |r| r.values_at("case", "rep") }

  # Checks every case without model calls: the oracle answer passes, the null
  # answer fails, and every decoy fails. Each case needs at least one decoy.
  def cmd_selftest(opts)
    bad = 0
    load_cases(opts[:cases]).each do |c|
      problems = []
      begin
        g, d = grade(c, c["oracle"], [])
        problems << "oracle fails: #{d.except('workspace_changes')}" unless g["pass"] == 1
        problems << "null answer passes" unless grade(c, NULL_ANSWER, [])[0]["pass"].zero?
        problems << "no decoys" if c["decoys"].to_a.empty?
        c["decoys"].to_a.each_with_index do |text, i|
          problems << "decoy #{i} passes: #{text[0, 80].inspect}" unless grade(c, text, [])[0]["pass"].zero?
        end
        problems << "clean oracle with a changed workspace passes" unless grade(c, c["oracle"], ["?? x"])[0]["pass"].zero?
      rescue RegexpError, KeyError, NoMethodError => e
        problems << "malformed case: #{e.message}"
      end
      bad += 1 if problems.any?
      puts "#{problems.empty? ? 'ok  ' : 'FAIL'} #{c['id']} (#{c['must_include'].size} facts, #{c['decoys'].to_a.size} decoys)" +
           problems.map { |p| "\n    #{p}" }.join
    end
    bad.zero? ? 0 : 1
  end

  def median(xs)
    s = xs.compact.sort
    return nil if s.empty?

    s.size.odd? ? s[s.size / 2] : (s[s.size / 2 - 1] + s[s.size / 2]) / 2.0
  end

  # Per-case pass counts. No verdict: the decision rule is the owner's (PREREG.md).
  def by_case(rows) = rows.group_by { |r| r["case"] }.transform_values { |rs| [rs.sum { |r| r["grade"]["pass"] }, rs.size] }

  def summarize(vdir)
    rows = read_rows(vdir)
    errors = (p = File.join(vdir, "errors.jsonl")) && File.exist?(p) ? File.readlines(p, chomp: true).reject(&:empty?).size : 0
    k = rows.sum { |r| r["grade"]["pass"] }
    lo, hi = RoleEval.wilson(k, rows.size)
    pct = ->(x) { format("%.0f%%", x * 100) }
    fails = CHECKS.map { |c| "#{c} #{rows.count { |r| r['grade'][c] == 0 }}" }.join(", ")
    usd = rows.sum { |r| r["api_equiv_usd"] || 0 }
    puts "#{File.basename(vdir)}: pass #{k}/#{rows.size} = #{pct.(rows.empty? ? 0 : k.fdiv(rows.size))} " \
         "(95% Wilson #{pct.(lo)}-#{pct.(hi)}); failed checks: #{fails}; " \
         "truncated #{rows.count { |r| r['status'] != 'ok' }}; errors #{errors}; " \
         "median wall #{median(rows.map { |r| r['wall_s'] })}s, turns #{median(rows.map { |r| r['turns'] })}, " \
         "tool calls #{median(rows.map { |r| r['tool_calls'] })}, " \
         "output tokens #{median(rows.map { |r| r.dig('usage', 'output_tokens') })}; " \
         "API-equivalent usage $#{format('%.2f', usd)} (subscription; not billed)"
    by_case(rows).sort.each do |id, (n_pass, n)|
      notes = rows.select { |r| r["case"] == id }.flat_map { |r| r["missing_facts"] + r["forbidden_hits"].map { |h| "forbidden #{h}" } }.uniq
      notes << "workspace changed" if rows.any? { |r| r["case"] == id && r["grade"]["read_only"] == 0 }
      puts "  #{id}: #{n_pass}/#{n}#{notes.empty? ? '' : "  (#{notes.join('; ')})"}"
    end
    0
  end

  def main(argv)
    cmd = argv.shift
    opts = { reps: 3, concurrency: 3, timeout_s: 900, max_turns: 100, retries: 1, keep: false, approve_harness: false }
    parser = OptionParser.new do |o|
      o.banner = "usage: helper_eval.rb run|selftest|summary [options]"
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
  exit HelperEval.main(ARGV)
end
