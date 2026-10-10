# frozen_string_literal: true

require "minitest/autorun"
require_relative "helper_eval"

class HelperEvalTest < Minitest::Test
  CASE = {
    "id" => "c1",
    "must_include" => [
      { "fact" => "file", "any" => ["lib/app/cli\\.rb\\b"] },
      { "fact" => "count", "any" => ["(?i)\\b(two|2)\\s+call\\s+sites\\b", "(?i)\\bcall\\s+sites:\\s*2\\b"] }
    ],
    "must_not_include" => ["(?i)\\bthree\\s+call\\s+sites\\b"]
  }.freeze

  def grade(text, changes = []) = HelperEval.grade(CASE, text, changes)

  def test_passes_when_every_fact_matches_and_nothing_forbidden_and_workspace_clean
    g, d = grade("Two call sites, both in `lib/app/cli.rb:82`.")
    assert_equal({ "pass" => 1, "facts" => 1, "clean" => 1, "read_only" => 1 }, g)
    assert_empty d["missing_facts"]
    assert_empty d["forbidden_hits"]
  end

  def test_any_alternative_satisfies_a_fact
    assert_equal 1, grade("Call sites: 2 (lib/app/cli.rb)")[0]["pass"]
  end

  def test_tolerates_path_prefixes_and_line_suffixes
    ["./lib/app/cli.rb", "/tmp/ws/repo/lib/app/cli.rb:12", "`lib/app/cli.rb` (L12-14)"].each do |path|
      assert_equal 1, grade("2 call sites in #{path}")[0]["pass"], path
    end
  end

  def test_fails_and_names_the_missing_fact
    g, d = grade("Two call sites in cli.rb.")
    assert_equal [0, 0], g.values_at("pass", "facts")
    assert_equal ["file"], d["missing_facts"]
  end

  def test_a_forbidden_match_fails_even_with_all_facts
    g, d = grade("Two call sites in lib/app/cli.rb. Earlier I thought three call sites.")
    assert_equal [0, 1, 0], g.values_at("pass", "facts", "clean")
    assert_equal 1, d["forbidden_hits"].size
  end

  def test_null_and_empty_answers_fail
    [HelperEval::NULL_ANSWER, "", nil].each { |t| assert_equal 0, grade(t)[0]["pass"], t.inspect }
  end

  def test_workspace_changes_fail_a_correct_answer
    g, d = grade("Two call sites in lib/app/cli.rb.", ["?? notes.md"])
    assert_equal [0, 1, 1, 0], g.values_at("pass", "facts", "clean", "read_only")
    assert_equal ["?? notes.md"], d["workspace_changes"]
  end

  def test_workspace_changes_reports_edits_new_files_and_moved_head_but_not_excluded_paths
    Dir.mktmpdir do |dir|
      git = ->(*args) { assert RoleEval.sh(["git", "-c", "user.name=t", "-c", "user.email=t@t", *args], dir, 30).ok?, args.join(" ") }
      git.("init", "-q")
      File.write(File.join(dir, "a.txt"), "a\n")
      git.("add", "a.txt")
      git.("commit", "-q", "-m", "base")
      base = RoleEval.sh(["git", "rev-parse", "HEAD"], dir, 30).out.strip
      # Mirrors RoleEval.pin_role: the pinned role file is excluded, so it never counts.
      FileUtils.mkdir_p(File.join(dir, ".claude", "agents"))
      File.write(File.join(dir, ".claude", "agents", "helper-worker.md"), "pinned\n")
      File.open(File.join(dir, ".git", "info", "exclude"), "a") { |f| f.write("\n/.claude/agents/helper-worker.md\n") }
      assert_empty HelperEval.workspace_changes(dir, base)

      FileUtils.mkdir_p(File.join(dir, "tmp"))
      File.write(File.join(dir, "tmp", "scratch.txt"), "x\n")
      File.write(File.join(dir, "a.txt"), "b\n")
      assert_equal [" M a.txt", "?? tmp/scratch.txt"], HelperEval.workspace_changes(dir, base).sort

      git.("commit", "-qam", "edit")
      FileUtils.rm_rf(File.join(dir, "tmp"))
      changes = HelperEval.workspace_changes(dir, base)
      assert_equal 1, changes.size
      assert_match(/\AHEAD moved: #{base[0, 12]} -> \h{12}\z/, changes.first)
    end
  end

  def test_harness_paths
    assert_equal ["scripts/helper_eval.rb", "scripts/role_eval.rb", "evals/roles/helper-worker/cases.json"],
                 HelperEval::HARNESS_PATHS
  end

  def test_by_case_counts_passes_per_case
    rows = [["a", 1], ["a", 0], ["a", 1], ["b", 0]].map { |id, p| { "case" => id, "grade" => { "pass" => p } } }
    assert_equal({ "a" => [2, 3], "b" => [0, 1] }, HelperEval.by_case(rows))
  end
end
