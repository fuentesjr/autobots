# frozen_string_literal: true

require "minitest/autorun"
require_relative "routing_gate"

class RoutingGateTest < Minitest::Test
  AGENTS_DIR = File.expand_path("../.claude/agents", __dir__)

  def test_parses_folded_description
    text = "---\nname: helper\ndescription: >-\n  Line one.\n  Line two.\nmodel: sonnet\n---\nbody\n"
    assert_equal({ "name" => "helper", "description" => "Line one.\nLine two." },
                 RoutingGate.parse_frontmatter(text))
  end

  def test_parses_plain_description
    text = "---\nname: helper\ndescription: One line.\n---\n"
    assert_equal "One line.", RoutingGate.parse_frontmatter(text)["description"]
  end

  def test_rejects_missing_frontmatter
    assert_raises(ArgumentError) { RoutingGate.parse_frontmatter("no frontmatter\n") }
  end

  def test_strips_example_blocks
    desc = "Use it for X.\n<example>\nuser: hi\n</example>\n<example>two</example>"
    assert_equal "Use it for X.", RoutingGate.strip_examples(desc)
  end

  def test_loads_the_real_roster
    agents = RoutingGate.load_agents(AGENTS_DIR, true)
    assert_includes agents.map { |a| a["name"] }, "coding-worker"
    refute(agents.any? { |a| a["description"].include?("<example>") })
  end

  def test_normalizes_answers
    valid = %w[coding-worker fast-coding-worker none]
    assert_equal "coding-worker", RoutingGate.normalize_answer("`coding-worker`.\nbecause", valid)
    assert_equal "fast-coding-worker", RoutingGate.normalize_answer("I pick fast-coding-worker", valid)
    assert_equal "none", RoutingGate.normalize_answer("None", valid)
    assert_equal "INVALID:planner", RoutingGate.normalize_answer("planner", valid)
    assert_equal "INVALID:", RoutingGate.normalize_answer("  ", valid)
  end
end
