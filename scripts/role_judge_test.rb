# frozen_string_literal: true

require "minitest/autorun"
require "tmpdir"
require_relative "role_judge"

class RoleJudgeTest < Minitest::Test
  # Values produced by Python's random.Random(int(sha256(key), 16)).random().
  def test_pair_order_matches_the_python_judge
    assert RoleJudge.a_first?("ctx-a1", 0, "judge")     # 0.4757...
    assert RoleJudge.a_first?("sk-acr", 1, "calib")     # 0.4441...
  end

  # judge_one against a fake `claude` on PATH that prints a canned JSON result.
  def with_fake_claude(json)
    Dir.mktmpdir do |bin|
      File.write(File.join(bin, "claude"), "#!/bin/sh\ncat >/dev/null\ncat <<'EOF'\n#{JSON.generate(json)}\nEOF\n")
      File.chmod(0o755, File.join(bin, "claude"))
      path = ENV["PATH"]
      ENV["PATH"] = "#{bin}:#{path}"
      yield
    ensure
      ENV["PATH"] = path
    end
  end

  def test_judge_falls_back_to_result_text_when_structured_output_is_empty
    reply = { "structured_output" => {}, "result" => '{"winner":"tie","reasons":"same"}',
              "modelUsage" => { "claude-fable-5-1" => {} } }
    with_fake_claude(reply) do
      j = RoleJudge.judge_one("task", "a", "b", "claude-fable-5-1")
      assert_equal "tie", j["verdict"]["winner"]
      assert_equal ["claude-fable-5-1"], j["served"]
    end
  end

  def test_judge_rejects_an_unknown_winner
    with_fake_claude({ "structured_output" => { "winner" => "b", "reasons" => "" } }) do
      assert_raises(RuntimeError) { RoleJudge.judge_one("task", "a", "b", "m") }
    end
  end

  # The local eval data is gitignored, so this runs only where it exists.
  def test_recorded_judge_rows_reproduce
    rows = RoleJudge.read_jsonl(RoleJudge::OUT)
    skip "no local judge.jsonl" if rows.empty?

    rows.each do |r|
      expected = RoleJudge.a_first?(r["prompt_id"], r["rep"], "judge") ? "baseline" : "v1"
      assert_equal expected, r["A"], "#{r['prompt_id']} rep#{r['rep']}"
    end
  end
end
