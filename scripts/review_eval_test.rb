# frozen_string_literal: true

require "minitest/autorun"
require_relative "review_eval"

class ReviewEvalTest < Minitest::Test
  FENCE = "`" * 3

  def test_findings_reads_the_last_json_block
    text = "Review.\n#{FENCE}json\n[{\"file\":\"a.rb\"}]\n#{FENCE}\nMore.\n#{FENCE}json\n" \
           "[{\"file\":\"lib/x.rb\",\"line\":9,\"severity\":\"Blocking\",\"summary\":\"s\"}]\n#{FENCE}\n"
    assert_equal [{ "file" => "lib/x.rb", "line" => 9, "severity" => "Blocking", "summary" => "s" }],
                 ReviewEval.findings(text)
  end

  def test_findings_is_nil_without_a_parseable_list
    assert_nil ReviewEval.findings("no block here")
    assert_nil ReviewEval.findings("#{FENCE}json\n{not json\n#{FENCE}")
    assert_nil ReviewEval.findings("#{FENCE}json\n{\"file\":\"a\"}\n#{FENCE}")
    assert_equal [], ReviewEval.findings("#{FENCE}json\n[]\n#{FENCE}")
  end

  def test_normalize_handles_paths_line_strings_and_severity_words
    ws = "/tmp/role-eval-x/repo"
    f = ReviewEval.normalize({ "file" => "#{ws}/lib/x.rb:12", "line" => nil, "severity" => "Should-fix" }, ws)
    assert_equal ["lib/x.rb", 12, "should-fix"], f.values_at("file", "line", "severity")
    f = ReviewEval.normalize({ "file" => "./lib/x.rb", "line" => "40-44", "severity" => "nit" }, ws)
    assert_equal ["lib/x.rb", 40, "nit"], f.values_at("file", "line", "severity")
    assert_equal "blocking", ReviewEval.normalize({ "file" => "a", "severity" => "BLOCKING (security)" }, ws)["severity"]
  end

  def test_grade_counts_a_bug_caught_near_its_lines_at_actionable_severity
    item = { "kind" => "planted", "bugs" => [
      { "id" => "b1", "file" => "lib/x.rb", "lines" => [20, 22] },
      { "id" => "b2", "file" => "lib/y.rb", "lines" => [5, 5] },
      { "id" => "b3", "file" => "lib/z.rb", "lines" => [50, 50] }
    ] }
    fs = [
      { "file" => "lib/x.rb", "line" => 27, "severity" => "should-fix" },  # within slack of b1
      { "file" => "lib/y.rb", "line" => 5, "severity" => "nit" },          # right place, nit: not a catch
      { "file" => "lib/z.rb", "line" => 56, "severity" => "blocking" },    # outside slack
      { "file" => "lib/w.rb", "line" => 1, "severity" => "blocking" }
    ]
    g = ReviewEval.grade(item, fs)
    assert_equal ["b1"], g["caught"]
    assert_equal %w[b2 b3], g["missed"]
    assert_equal 2, g["blocking"]
    assert_equal 1, g["should_fix"]
    assert_equal 1, g["nits"]
  end

  def test_grade_accepts_alternate_locations_and_ignores_sprawling_ranges
    item = { "kind" => "planted", "bugs" => [
      { "id" => "b1", "file" => "lib/x.rb", "lines" => [20, 20], "alt" => [{ "file" => "lib/cli.rb", "lines" => [3, 3] }] },
      { "id" => "b2", "file" => "lib/y.rb", "lines" => [100, 100] }
    ] }
    fs = [
      { "file" => "lib/cli.rb", "line" => 4, "severity" => "blocking", "summary" => "caller" },
      # A range wider than MAX_RANGE counts at its first line only.
      { "file" => "lib/y.rb", "line" => 1, "line_end" => 200, "severity" => "blocking" }
    ]
    g = ReviewEval.grade(item, fs)
    assert_equal ["b1"], g["caught"]
    assert_equal({ "b1" => "caller" }, g["matched"])
  end

  def test_added_lines_maps_each_file_to_its_new_plus_line_numbers
    diff = <<~DIFF
      diff --git a/lib/x.rb b/lib/x.rb
      --- a/lib/x.rb
      +++ b/lib/x.rb
      @@ -1,3 +1,4 @@
       a
      -b
      +B
      +C
       d
      @@ -10,2 +11,2 @@
       k
      +L
      diff --git a/bin/new b/bin/new
      new file mode 100755
      --- /dev/null
      +++ b/bin/new
      @@ -0,0 +1,2 @@
      +#!/bin/sh
      +echo hi
    DIFF
    assert_equal({ "lib/x.rb" => [2, 3, 12], "bin/new" => [1, 2] }, ReviewEval.added_lines(diff))
  end

  def test_grade_with_no_findings_list_misses_everything
    item = { "kind" => "planted", "bugs" => [{ "id" => "b1", "file" => "a", "lines" => [1, 1] }] }
    g = ReviewEval.grade(item, nil)
    assert_equal [], g["caught"]
    assert_equal ["b1"], g["missed"]
    assert_equal false, g["format_ok"]
  end

  def test_prompt_embeds_the_task_and_asks_for_the_findings_block
    p = ReviewEval.prompt("Fix the bug.")
    assert_includes p, "<task>\nFix the bug.\n</task>"
    assert_includes p, "#{FENCE}json"
    assert_includes p, "blocking|should-fix|nit"
  end
end
