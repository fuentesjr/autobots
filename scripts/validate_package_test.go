package main

import "testing"

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
