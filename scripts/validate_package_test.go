package main

import (
	"slices"
	"testing"
)

// TestSplitFrontmatter is a minimal sanity check (ACC-2) that the
// frontmatter/body splitting helper behaves on a trivial well-formed input.
func TestSplitFrontmatter(t *testing.T) {
	content := "---\nname: foo\n---\nHello body.\n"
	fm, body, err := splitFrontmatter(content)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if fm != "name: foo" {
		t.Fatalf("unexpected frontmatter: %q", fm)
	}
	if body == "" {
		t.Fatalf("expected non-empty body")
	}
}

func TestSplitFrontmatterMissingFence(t *testing.T) {
	if _, _, err := splitFrontmatter("no frontmatter here"); err == nil {
		t.Fatalf("expected an error for content missing a frontmatter fence")
	}
}

// TestMentionsRole covers the standalone-identifier rule (VAL-7/VAL-8): a
// role name embedded in a longer identifier must not count as a mention.
func TestMentionsRole(t *testing.T) {
	cases := []struct {
		content string
		name    string
		want    bool
	}{
		{"route this to `reviewer` first", "reviewer", true},
		{"reviewer", "reviewer", true},
		{"the doc-reviewer role checks docs", "reviewer", false},
		{"fast-coding-worker handles small fixes", "coding-worker", false},
		{"| `coding-worker` | `sonnet` |", "coding-worker", true},
		{"no roles mentioned here", "planner", false},
		{"doc-reviewer and `reviewer` both appear", "reviewer", true},
	}
	for _, c := range cases {
		if got := mentionsRole(c.content, c.name); got != c.want {
			t.Errorf("mentionsRole(%q, %q) = %v, want %v", c.content, c.name, got, c.want)
		}
	}
}

func TestParseDesignAccessTable(t *testing.T) {
	design := `intro prose

| Role | Access | Model | Effort | Responsibility |
|---|---|---:|---|---|
| ` + "`planner`" + ` | read-only | Opus 4.8 | high | plans things |
| ` + "`coding-worker`" + ` | writable | Sonnet 5 | medium | writes code |

trailing prose
`
	got := parseDesignAccessTable(design)
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d: %v", len(got), got)
	}
	if got["planner"] != "read-only" {
		t.Errorf("planner access = %q, want %q", got["planner"], "read-only")
	}
	if got["coding-worker"] != "writable" {
		t.Errorf("coding-worker access = %q, want %q", got["coding-worker"], "writable")
	}
}

func TestParseDesignAccessTableMissing(t *testing.T) {
	if got := parseDesignAccessTable("no table at all"); len(got) != 0 {
		t.Fatalf("expected empty map for content without a table, got %v", got)
	}
}

func TestParsePatternTable(t *testing.T) {
	content := `prose

| Pattern | Triggers | Roles used |
|---|---|---|
| ` + "`orchestrator-worker`" + ` (default) | any dispatch | all roles |
| ` + "`advisory`" + ` | "use the advisor strategy" | one executor (` + "`coding-worker`" + `) + ` + "`advisor`" + ` |

prose after
`
	got := parsePatternTable(content)
	if len(got) != 2 {
		t.Fatalf("expected 2 patterns, got %d: %v", len(got), got)
	}
	if _, ok := got["orchestrator-worker"]; !ok {
		t.Errorf("missing pattern orchestrator-worker: %v", got)
	}
	roles := got["advisory"]
	if roles == "" || !slices.Contains(extractAllBackticks(roles), "advisor") {
		t.Errorf("advisory roles cell %q should reference `advisor`", roles)
	}
}

func TestParsePatternTableMissing(t *testing.T) {
	if got := parsePatternTable("| Pattern | Wrong | Header |\n|---|---|---|\n| `x` | y | z |"); len(got) != 0 {
		t.Fatalf("expected empty map for content without the registry header, got %v", got)
	}
}

// TestScanLineForEntries covers the AGENTS=( ... ) scanner used by VAL-11.
func TestScanLineForEntries(t *testing.T) {
	found := map[string]bool{}
	scanLineForEntries("  planner  # trailing comment", found)
	scanLineForEntries("  # pure comment line", found)
	scanLineForEntries("", found)
	scanLineForEntries("  coding-worker", found)
	scanLineForEntries("not a single token", found)
	want := map[string]bool{"planner": true, "coding-worker": true}
	if len(found) != len(want) {
		t.Fatalf("found = %v, want %v", found, want)
	}
	for name := range want {
		if !found[name] {
			t.Errorf("expected %q to be found: %v", name, found)
		}
	}
}
