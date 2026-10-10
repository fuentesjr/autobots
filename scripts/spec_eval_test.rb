# frozen_string_literal: true

require "minitest/autorun"
require_relative "spec_eval"

class SpecEvalTest < Minitest::Test
  def row(id, pass) = { "case" => id, "grade" => { "pass" => pass } }

  def test_harness_paths
    assert_equal ["scripts/spec_eval.rb", "scripts/role_eval.rb", "evals/roles/spec-test-writer/cases.json",
                  "evals/roles/spec-test-writer/briefs", "evals/roles/spec-test-writer/references",
                  "evals/roles/spec-test-writer/mutants", "evals/roles/spec-test-writer/witnesses"],
                 SpecEval::HARNESS_PATHS
  end

  def test_in_scope_matches_path_prefixes_only
    assert SpecEval.in_scope?("test/ctxpack/x_test.rb", ["test/"])
    refute SpecEval.in_scope?("lib/test/x.rb", ["test/"])
    refute SpecEval.in_scope?("testdata/x", ["test/"])
  end

  def test_verdict_certifies_at_the_threshold_with_no_zero_case
    rows = (1..10).flat_map { |i| [row("c#{i}", 1), row("c#{i}", i <= 3 ? 0 : 1)] }
    v = SpecEval.verdict(rows)
    assert_equal [17, 20], v.values_at("passes", "runs")
    assert v["certified"]
  end

  def test_verdict_fails_below_the_threshold
    rows = (1..10).flat_map { |i| [row("c#{i}", 1), row("c#{i}", i <= 4 ? 0 : 1)] }
    refute SpecEval.verdict(rows)["certified"]
  end

  def test_verdict_fails_when_a_case_fails_every_rep
    rows = (1..9).flat_map { |i| [row("c#{i}", 1), row("c#{i}", 1)] } + [row("c10", 0), row("c10", 0)]
    v = SpecEval.verdict(rows)
    assert_equal 18, v["passes"]
    assert_equal ["c10"], v["zero_cases"]
    refute v["certified"]
  end
end
