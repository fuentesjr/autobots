#!/usr/bin/env ruby
# frozen_string_literal: true

# Static role-routing gate for agent frontmatter example deletion.
#
# skill-tester materializes only skill packages, not .claude/agents or
# .grok/agents, so role selection cannot be gated there. This script presents
# the agent roster (name + description, optionally with <example> blocks
# stripped) and asks a model to pick one role name or "none".
#
# Usage:
#   routing_gate.rb --agents-dir DIR --scenarios JSON --provider claude|grok \
#                   [--strip-examples] [--n N] [--out PATH] [--model M]

require "fileutils"
require "json"
require "open3"
require "optparse"

module RoutingGate
  module_function

  def parse_frontmatter(text)
    m = text.match(/\A---\n(.*?)\n---\n/m) or raise ArgumentError, "missing frontmatter"
    block = m[1]
    name = block[/^name:\s*(\S+)\s*$/, 1] or raise ArgumentError, "missing name"
    if (folded = block.match(/^description:\s*>-\n((?:  .*\n)+)/))
      desc = folded[1].lines.map { |ln| ln.delete_prefix("  ") }.join.strip
    else
      desc = block[/^description:\s*(.+)$/, 1] or raise ArgumentError, "missing description"
      desc = desc.strip
    end
    { "name" => name, "description" => desc }
  end

  def strip_examples(desc)
    desc.gsub(%r{\n?\s*<example>.*?</example>}m, "").strip
  end

  def load_agents(agents_dir, strip)
    Dir.glob(File.join(agents_dir, "*.md")).sort.map do |path|
      meta = parse_frontmatter(File.read(path))
      meta["description"] = strip_examples(meta["description"]) if strip
      meta
    end
  end

  def load_scenarios(path)
    # JSON only (no YAML dependency). YAML files are frozen mirrors only.
    abort "use routing-scenarios.json (got #{path})" unless File.extname(path) == ".json"
    JSON.parse(File.read(path))
  end

  def build_prompt(agents, user_prompt, valid_names)
    roster = agents.map { |a| "### #{a['name']}\n#{a['description']}\n" }.join("\n")
    names = (valid_names + ["none"]).join(", ")
    <<~PROMPT
      You are a dispatcher. Given the agent roster below, pick exactly one agent
      to handle the user request, or "none" if the request says to handle locally /
      escape hatches / no subagents.

      Reply with ONLY the agent name (or none). No punctuation, no explanation.
      Valid answers: #{names}

      ## Roster

      #{roster}

      ## User request

      #{user_prompt}
    PROMPT
  end

  # Returns [stdout, stderr, status], or nil on timeout.
  def capture(cmd, timeout_s)
    Open3.popen3(*cmd, pgroup: true) do |stdin, stdout, stderr, wait|
      stdin.close
      out = Thread.new { stdout.read }
      err = Thread.new { stderr.read }
      unless wait.join(timeout_s)
        Process.kill("KILL", -wait.pid)
        wait.join
        [out, err].each(&:join)
        return nil
      end
      [out.value, err.value, wait.value]
    end
  end

  # Returns [response text, model IDs the alias resolved to].
  def run_claude(prompt, model)
    cmd = ["claude", "--safe-mode", "--tools", "", "--permission-mode", "dontAsk",
           "--no-session-persistence", "-p", "--output-format", "json", "--model", model, prompt]
    out, err, status = capture(cmd, 180) || (return ["ERROR:timeout", []])
    return ["ERROR:#{status.exitstatus}:#{err[0, 200]}", []] unless status.success?

    begin
      res = JSON.parse(out)
    rescue JSON::ParserError
      return ["ERROR:bad-json:#{out[0, 200]}", []]
    end
    [res.fetch("result", "").to_s.strip, (res["modelUsage"] || {}).keys.sort]
  end

  def run_grok(prompt, model)
    # Headless single-turn: -p prints the response and exits.
    out, err, status = capture(["grok", "-p", prompt, "-m", model, "--tools", ""], 180) ||
                       (return ["ERROR:timeout", []])
    return ["ERROR:#{status.exitstatus}:#{(err.empty? ? out : err)[0, 200]}", []] unless status.success?

    # grok -p does not report the resolved model ID.
    [out.strip, []]
  end

  def normalize_answer(raw, valid)
    line = raw.strip.empty? ? "" : raw.strip.lines.first.chomp
    line = line.gsub(/\A[`'" .]+|[`'" .]+\z/, "")
    lower = line.downcase
    return lower if valid.include?(lower)

    found = valid.sort_by { |n| -n.length }.find { |n| lower.include?(n) }
    found || "INVALID:#{line[0, 80]}"
  end

  def parse_args(argv)
    opts = { strip_examples: false }
    OptionParser.new do |o|
      o.on("--agents-dir DIR") { |v| opts[:agents_dir] = v }
      o.on("--scenarios PATH") { |v| opts[:scenarios] = v }
      o.on("--provider P", %w[claude grok]) { |v| opts[:provider] = v }
      o.on("--strip-examples") { opts[:strip_examples] = true }
      o.on("--n N", Integer) { |v| opts[:n] = v }
      o.on("--out PATH") { |v| opts[:out] = v }
      o.on("--model M") { |v| opts[:model] = v }
    end.parse!(argv)
    missing = %i[agents_dir scenarios provider].reject { |k| opts[k] }
    abort "missing required: #{missing.map { |k| "--#{k.to_s.tr('_', '-')}" }.join(', ')}" if missing.any?
    opts
  end

  def main(argv)
    opts = parse_args(argv)
    scenarios = load_scenarios(opts[:scenarios])
    n = opts[:n] || Integer(scenarios.fetch("n_trials", 1))
    model = opts[:model] || scenarios["model"] || (opts[:provider] == "claude" ? "sonnet" : "grok-4.5")
    agents = load_agents(opts[:agents_dir], opts[:strip_examples])
    valid = agents.map { |a| a["name"] } + ["none"]

    results = { "provider" => opts[:provider], "model" => model, "resolved_models" => [],
                "strip_examples" => opts[:strip_examples], "n" => n, "cases" => [],
                "pass_rate" => 0.0, "n_pass" => 0, "n_total" => 0 }
    resolved = []
    scenarios.fetch("cases").each do |c|
      trials = (1..n).map do |i|
        prompt = build_prompt(agents, c["prompt"].strip, (valid - ["none"]).sort + ["none"])
        raw, ids = opts[:provider] == "claude" ? run_claude(prompt, model) : run_grok(prompt, model)
        resolved |= ids
        ans = normalize_answer(raw, valid)
        sleep 0.3
        { "trial" => i, "raw" => raw[0, 200], "answer" => ans, "ok" => ans == c["expected"] }
      end
      pass = trials.count { |t| t["ok"] }
      results["cases"] << { "id" => c["id"], "expected" => c["expected"], "pass" => pass, "n" => n,
                            "rate" => pass.fdiv(n), "trials" => trials }
      results["n_pass"] += pass
      results["n_total"] += n
      puts "#{c['id']}: #{pass}/#{n} expected=#{c['expected']}"
    end

    results["resolved_models"] = resolved.sort
    results["pass_rate"] = results["n_total"].zero? ? 0.0 : results["n_pass"].fdiv(results["n_total"])
    puts "MODEL: #{model} -> #{results['resolved_models'].empty? ? 'unreported' : results['resolved_models'].join(', ')}"
    puts format("OVERALL: %d/%d (%.1f%%)", results["n_pass"], results["n_total"], results["pass_rate"] * 100)

    if opts[:out]
      FileUtils.mkdir_p(File.dirname(opts[:out]))
      File.write(opts[:out], JSON.pretty_generate(results))
      puts "wrote #{opts[:out]}"
    end
    results["pass_rate"] >= 0.8 ? 0 : 1
  end
end

if $PROGRAM_NAME == __FILE__
  $stdout.sync = true
  exit RoutingGate.main(ARGV)
end
