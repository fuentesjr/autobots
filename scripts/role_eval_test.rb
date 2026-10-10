# frozen_string_literal: true

require "minitest/autorun"
require "pathname"
require "tmpdir"
require_relative "role_eval"

class RoleEvalTest < Minitest::Test
  def test_out_of_scope_prefix_rules
    rules = [".trk/", "Gemfile.lock"]
    assert_equal [".trk/STATE.md"], RoleEval.out_of_scope(["lib/a.rb", ".trk/STATE.md"], rules)
  end

  def test_out_of_scope_negated_rule_allows_only_that_prefix
    paths = ["skills/acr/SKILL.md", "skills/other/SKILL.md"]
    assert_equal ["skills/other/SKILL.md"], RoleEval.out_of_scope(paths, ["!skills/acr/"])
  end

  def test_wilson_interval
    assert_equal [0.0, 0.0], RoleEval.wilson(0, 0)
    lo, hi = RoleEval.wilson(24, 24)
    assert_in_delta 0.86202, lo, 1e-5
    assert_equal 1.0, hi
  end

  def test_trace_counts_tools_and_carries_thinking
    events = [
      { "type" => "system", "subtype" => "init", "model" => "m", "apiKeySource" => "none", "permissionMode" => "auto" },
      { "type" => "assistant", "message" => { "content" => [
        { "type" => "thinking", "thinking" => "plan" },
        { "type" => "tool_use", "name" => "Read", "input" => { "file_path" => "a" } }
      ] } },
      { "type" => "user", "message" => { "content" => [
        { "type" => "tool_result", "content" => [{ "type" => "text", "text" => "body" }] }
      ] } },
      { "type" => "assistant", "message" => { "content" => [{ "type" => "text", "text" => "done" }] } }
    ]
    trace, tools = RoleEval.to_trace(events)
    assert_equal 1, tools
    assert_equal "init: model=m apiKeySource=none permissionMode=auto", trace[0]["content"]
    assert_equal({ "role" => "tool_call", "name" => "Read", "content" => "{\n  \"file_path\": \"a\"\n}",
                   "thinking" => "plan" }, trace[1])
    assert_equal({ "role" => "tool_result", "content" => "body" }, trace[2])
    assert_equal({ "role" => "assistant", "content" => "done" }, trace[3])
  end

  def test_verified_means_a_test_command_ran_after_the_last_file_edit
    edit = { "role" => "tool_call", "name" => "Edit", "content" => "{}" }
    bash = ->(cmd) { { "role" => "tool_call", "name" => "Bash", "content" => JSON.generate("command" => cmd) } }
    assert_equal 1, RoleEval.verified([edit, bash.("bundle exec rake test 2>&1 | tail -3")])
    assert_equal 1, RoleEval.verified([edit, bash.("bundle exec ruby -Ilib -Itest test/ctxpack/cli_test.rb")])
    assert_equal 1, RoleEval.verified([edit, bash.("for t in a b; do bash test/${t}_test.sh; done")])
    assert_equal 0, RoleEval.verified([bash.("bundle exec rake test"), edit, bash.("git diff")])
    assert_nil RoleEval.verified([bash.("bundle exec rake test 2>&1 >/dev/null")])
    # Bash writes count as edits; a write-then-test call counts as verified.
    assert_equal 0, RoleEval.verified([edit, bash.("rake test"), bash.("python3 - <<'EOF'\nopen(p,'w').write(s)\nEOF")])
    assert_equal 0, RoleEval.verified([bash.("sed -i '' 's/a/b/' lib/x.rb")])
    assert_equal 0, RoleEval.verified([bash.("cat > bin/tool <<'EOF'\nx\nEOF")])
    assert_equal 1, RoleEval.verified([bash.("sed -i 's/a/b/' lib/x.rb && bundle exec rake test")])
    # Writes into a mktemp scratch dir are experiments, not edits to the repo.
    assert_equal 1, RoleEval.verified([edit, bash.("rake test"), bash.("T=$(mktemp -d); echo x > $T/a.rb")])
  end

  def test_verified_ignores_doc_edits_stash_reads_and_mktemp_inside_heredoc_bodies
    edit = ->(path) { { "role" => "tool_call", "name" => "Edit", "content" => JSON.pretty_generate("file_path" => path) } }
    bash = ->(cmd) { { "role" => "tool_call", "name" => "Bash", "content" => JSON.generate("command" => cmd) } }
    # A script whose body uses mktemp is still a repo write; its own test runs in the same call.
    write_and_test = <<~SH
      cat > bin/install_report <<'EOF'
      #!/bin/bash
      tmp=$(mktemp -d)
      echo report > "$tmp/out"
      EOF
      cat > test/install_report_test.sh <<'EOF'
      #!/bin/bash
      bin/install_report
      EOF
      bash test/install_report_test.sh
    SH
    assert_equal 1, RoleEval.verified([bash.(write_and_test)])
    # Listing or showing stashes changes nothing; stash and stash pop do.
    assert_equal 1, RoleEval.verified([edit.("lib/x.rb"), bash.("git stash"), bash.("rake test"), bash.("git stash pop"),
                                       bash.("rake test"), bash.("git status --short && git stash list")])
    assert_equal 0, RoleEval.verified([edit.("lib/x.rb"), bash.("rake test"), bash.("git stash pop")])
    # Doc edits after the last test don't unverify, and alone aren't edits.
    assert_equal 1, RoleEval.verified([edit.("lib/x.rb"), bash.("bundle exec rake test"), edit.("README.md")])
    assert_nil RoleEval.verified([edit.("README.md")])
    # mktemp in a heredoc body is content, so the repo write stands even with no test run.
    assert_equal 0, RoleEval.verified([bash.("cat > bin/x <<'EOF'\ntmp=$(mktemp -d)\nEOF")])
    # Only the body is stripped: mktemp on the opener line still marks a scratch write.
    assert_nil RoleEval.verified([bash.("cat <<EOF > \"$(mktemp -d)/a.rb\"\nx\nEOF")])
  end

  def test_quota_re_matches_the_subscription_session_limit_message
    assert_match RoleEval::QUOTA_RE, "You've hit your session limit · resets 1:30pm (America/Los_Angeles)"
    refute_match RoleEval::QUOTA_RE, "Review complete; no findings."
  end

  def test_parse_events_skips_non_json_lines
    assert_equal [{ "a" => 1 }], RoleEval.parse_events("{\"a\":1}\nnot json\n")
  end

  def test_diff_and_changed_paths_include_untracked_files
    Dir.mktmpdir do |ws|
      git = ->(*a) { RoleEval.run!("git", "-C", ws, *a) }
      git.("init", "-q")
      File.write(File.join(ws, "a.txt"), "one\n")
      git.("add", ".")
      git.("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base")
      base = git.("rev-parse", "HEAD").strip
      File.write(File.join(ws, "a.txt"), "two\n")
      File.write(File.join(ws, "new.txt"), "x\ny\n")

      assert_equal ["a.txt", "new.txt"], RoleEval.changed_paths(ws, base)
      diff, lines = RoleEval.snapshot_diff(ws, base)
      assert_equal 4, lines
      assert_includes diff, "+++ b/new.txt"
    end
  end

  def test_sh_kills_the_process_group_on_timeout
    Dir.mktmpdir do |dir|
      assert RoleEval.sh("sleep 30 & sleep 30", dir, 0.5).timed_out?
      assert_equal "hi\n", RoleEval.sh(["echo", "hi"], dir, 5).out
      refute RoleEval.sh("exit 3", dir, 5).ok?
    end
  end

  def test_sh_streams_large_stdin_and_stdout_without_deadlock
    Dir.mktmpdir do |dir|
      r = RoleEval.sh("head -c 300000 /dev/zero; wc -c", dir, 10, stdin: "x" * 300_000)
      refute r.timed_out?
      assert_equal "\0" * 300_000, r.out.byteslice(0, 300_000)
      assert_equal "300000", r.out.byteslice(300_000..).strip
    end
  end

  # A committed base in a fresh repo, for grade tests.
  def git_base(ws)
    RoleEval.run!("git", "init", "-q", ws)
    RoleEval.run!("git", "-C", ws, "-c", "user.name=t", "-c", "user.email=t@example.com",
                  "commit", "-q", "--allow-empty", "-m", "base")
    RoleEval.run!("git", "-C", ws, "rev-parse", "HEAD").strip
  end

  def test_grade_reruns_a_flaky_suite_once
    Dir.mktmpdir do |dir|
      ws = File.join(dir, "ws")
      base = git_base(ws)
      File.write(File.join(ws, "fix.txt"), "x\n")
      hidden = File.join(dir, "hidden.sh")
      File.write(hidden, "exit 0\n")
      # Fails on the first run only; the marker lives outside the workspace.
      marker = File.join(dir, "ran")
      c = { "offlimits" => [], "hidden" => Pathname(hidden).relative_path_from(RoleEval::EVAL_DIR).to_s,
            "suite" => "if [ -e #{marker} ]; then exit 0; else touch #{marker}; echo boom; exit 1; fi" }
      g, detail = RoleEval.grade(c, ws, base, {})
      assert_equal({ "pass" => 1, "hidden" => 1, "suite" => 1, "scope" => 1, "changed" => 1 }, g)
      assert detail["suite_flaky"]
      assert_includes detail["first_suite_tail"], "boom"
    end
  end

  def test_grade_raises_when_a_grading_command_times_out
    Dir.mktmpdir do |ws|
      base = git_base(ws)
      real = RoleEval.method(:sh)
      # Fake a timeout for the suite (a shell string) only.
      RoleEval.define_singleton_method(:sh) do |cmd, *rest, **kw|
        cmd.is_a?(String) ? RoleEval::Result.new("", "", nil) : real.call(cmd, *rest, **kw)
      end
      err = assert_raises(RuntimeError) { RoleEval.grade({ "offlimits" => [], "hidden" => "x", "suite" => "true" }, ws, base, {}) }
      assert_match(/timed out/, err.message)
    ensure
      RoleEval.define_singleton_method(:sh, real)
    end
  end

  def test_done_keys_resume_filtering
    Dir.mktmpdir do |vdir|
      File.write(File.join(vdir, "results.jsonl"), "{\"prompt_id\":\"a\",\"rep\":0}\n\n{\"prompt_id\":\"b\",\"rep\":1}\n")
      assert_equal [["a", 0], ["b", 1]], RoleEval.done_keys(vdir)
    end
  end

  def test_pin_role_pins_the_named_role_in_the_workspace
    Dir.mktmpdir do |ws|
      FileUtils.mkdir_p(File.join(ws, ".git", "info"))
      RoleEval.pin_role(ws, "fast-coding-worker", "claude-sonnet-5-5", "medium")
      text = File.read(File.join(ws, ".claude", "agents", "fast-coding-worker.md"))
      assert_match(/^name: fast-coding-worker$/, text)
      assert_match(/^model: claude-sonnet-5-5$/, text)
      assert_match(/^effort: medium$/, text)
      assert_includes File.read(File.join(ws, ".git", "info", "exclude")), "/.claude/agents/fast-coding-worker.md"
    end
  end

  def test_each_role_gets_its_own_flow_dir_and_shares_the_case_set
    assert_equal File.join(RoleEval::REPO, "evals", "roles", "coding-worker", "runs"), RoleEval.flow_dir("coding-worker")
    assert_equal File.join(RoleEval::REPO, "evals", "roles", "fast-coding-worker", "runs"), RoleEval.flow_dir("fast-coding-worker")
    assert_equal File.join(RoleEval::REPO, "evals", "roles", "coding-worker"), RoleEval::EVAL_DIR
  end

  def harness_tree(root)
    File.write(File.join(root, "one.txt"), "1\n")
    FileUtils.mkdir_p(File.join(root, "d", "sub"))
    File.write(File.join(root, "d", ".hidden"), "h\n")
    File.write(File.join(root, "d", "sub", "n.txt"), "n\n")
  end

  def test_harness_sha_digests_sorted_relpaths_and_bytes_including_dotfiles
    Dir.mktmpdir do |root|
      harness_tree(root)
      expected = Digest::SHA256.hexdigest("one.txt" "1\n" "d/.hidden" "h\n" "d/sub/n.txt" "n\n")
      assert_equal expected, RoleEval.harness_sha(["one.txt", "d"], root: root)
    end
  end

  def test_gate_harness_approves_passes_and_refuses_a_tampered_harness
    Dir.mktmpdir do |root|
      harness_tree(root)
      flow = File.join(root, "runs")
      FileUtils.mkdir_p(flow)
      File.write(File.join(flow, "_state.json"), JSON.generate("unrelated" => "keep"))
      paths = ["one.txt", "d"]
      capture_io { RoleEval.gate_harness(true, flow, paths: paths, root: root) }
      state = JSON.parse(File.read(File.join(flow, "_state.json")))
      assert_equal "keep", state["unrelated"]
      assert_equal paths, state["harness_paths"]
      assert_equal RoleEval.harness_sha(paths, root: root), state["harness_sha"]

      RoleEval.gate_harness(false, flow, paths: paths, root: root) # unchanged harness: no exit

      File.write(File.join(root, "d", "sub", "n.txt"), "tampered\n")
      err = assert_raises(SystemExit) { capture_io { RoleEval.gate_harness(false, flow, paths: paths, root: root) } }
      assert_equal 2, err.status
    end
  end

  # A run_agent return hash for fault: result/init as the stream would carry them.
  def fault_run(result: nil, init: {}, timeout: false, stderr: "boom")
    usage = result && (result["modelUsage"] || {}) || {}
    { timeout: timeout, stderr: stderr, result: result, init: init, usage_models: usage,
      model: usage.max_by { |_, u| u.fetch("outputTokens", 0) }&.first }
  end

  def test_fault_classifies_every_ungradable_run
    m = "claude-opus-5-5"
    usage = { m => { "outputTokens" => 90 }, "claude-haiku-5-5" => { "outputTokens" => 10 } }
    ok = { "is_error" => false, "subtype" => "success", "result" => "done", "modelUsage" => usage }
    cases = {
      "timeout" => [fault_run(timeout: true, result: ok),
                    { row: { "class" => "timeout" }, stop: false, retry: false }],
      "no result" => [fault_run,
                      { row: { "class" => "harness", "stderr" => "boom" }, stop: false, retry: true }],
      "api key" => [fault_run(result: ok, init: { "apiKeySource" => "ANTHROPIC_API_KEY" }),
                    { row: { "class" => "billing", "apiKeySource" => "ANTHROPIC_API_KEY" }, stop: true, retry: false }],
      "quota" => [fault_run(result: ok.merge("is_error" => true, "result" => "You've hit your session limit" + "x" * 400)),
                  { row: { "class" => "quota", "result" => ("You've hit your session limit" + "x" * 400)[0, 300],
                           "modelUsage" => usage }, stop: true, retry: false }],
      "served model" => [fault_run(result: ok.merge("modelUsage" => { "claude-haiku-5-5" => { "outputTokens" => 5 } })),
                         { row: { "class" => "served_model_mismatch", "requested" => m,
                                  "modelUsage" => { "claude-haiku-5-5" => { "outputTokens" => 5 } } },
                           stop: false, retry: false }],
      "no usage" => [fault_run(result: ok.except("modelUsage")),
                     { row: { "class" => "served_model_mismatch", "requested" => m, "modelUsage" => {} },
                       stop: false, retry: false }],
      "is_error" => [fault_run(result: ok.merge("is_error" => true, "subtype" => "error_during_execution", "result" => "x")),
                     { row: { "class" => "harness", "subtype" => "error_during_execution", "result" => "x",
                              "modelUsage" => usage }, stop: false, retry: true }]
    }
    cases.each { |name, (run, want)| assert_equal want, RoleEval.fault(run, m), name }

    assert_nil RoleEval.fault(fault_run(result: ok), m)
    assert_nil RoleEval.fault(fault_run(result: ok, init: { "apiKeySource" => "none" }), m)
    # Max turns is gradable (the caller marks it truncated), even when flagged is_error.
    assert_nil RoleEval.fault(fault_run(result: ok.merge("is_error" => true, "subtype" => "error_max_turns")), m)
  end

  def test_sh_unsets_stripped_env_vars
    Dir.mktmpdir do |dir|
      ENV["CLAUDE_CODE_EFFORT_LEVEL"] = "high"
      out = RoleEval.sh("echo \"[${CLAUDE_CODE_EFFORT_LEVEL-unset}]\"", dir, 5, RoleEval::STRIP_VARS.to_h { |v| [v, nil] }).out
      assert_equal "[unset]\n", out
    ensure
      ENV.delete("CLAUDE_CODE_EFFORT_LEVEL")
    end
  end
end
