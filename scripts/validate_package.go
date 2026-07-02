// Command validate_package protects the Autobots package contract described
// in docs/spec.md §9 (VAL-1..VAL-14) and docs/design.md "Validation". It is
// the single source of truth for cross-file consistency between the agent
// roster (.claude/agents/*.md), the dispatcher skill (SKILL.md), the docs
// (README.md, docs/design.md, docs/faq.md, docs/cheatsheet.md), and the
// installer (scripts/install.sh).
//
// Run it with:
//
//	go run ./scripts/validate_package.go
//
// It prints a PASS/FAIL line per check and exits non-zero if any check
// fails (VAL-13).
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"gopkg.in/yaml.v3"
)

// ---------------------------------------------------------------------------
// Repo-relative paths. The validator is expected to be run from the repo
// root via `go run ./scripts/validate_package.go` (see docs/spec.md ACC-1
// and .github/workflows/validate.yml).
// ---------------------------------------------------------------------------

const (
	agentsDir      = ".claude/agents"
	skillPath      = ".claude/skills/autobots/SKILL.md"
	readmePath     = "README.md"
	designPath     = "docs/design.md"
	faqPath        = "docs/faq.md"
	cheatsheetPath = "docs/cheatsheet.md"
	installPath    = "scripts/install.sh"
)

var (
	allowedModels  = map[string]bool{"fable": true, "opus": true, "sonnet": true, "haiku": true}
	allowedEfforts = map[string]bool{"low": true, "medium": true, "high": true, "xhigh": true, "max": true}

	// Matches a bare kebab-case role-name token, e.g. `coding-worker`.
	roleNameRe = regexp.MustCompile(`^[a-z]+(-[a-z]+)*$`)

	// Matches a single well-formed tool identifier, e.g. `Read`, `NotebookEdit`.
	toolTokenRe = regexp.MustCompile(`^[A-Za-z]+$`)
)

// ---------------------------------------------------------------------------
// Frontmatter model
// ---------------------------------------------------------------------------

// frontmatter mirrors the subset of Claude Code agent frontmatter fields
// Autobots specs use (docs/spec.md AGT-5).
type frontmatter struct {
	Name        string `yaml:"name"`
	Description string `yaml:"description"`
	Model       string `yaml:"model"`
	Effort      string `yaml:"effort"`
	Tools       string `yaml:"tools"`
	Color       string `yaml:"color"`
}

// agentSpec is one parsed .claude/agents/<name>.md file.
type agentSpec struct {
	filename    string // e.g. "planner" (basename without .md)
	path        string
	raw         string
	frontmatter frontmatter
	body        string
	parseErr    error
}

// ---------------------------------------------------------------------------
// Check result bookkeeping
// ---------------------------------------------------------------------------

type checkResult struct {
	tag      string
	pass     bool
	messages []string // failure detail lines; empty when pass
}

var results []*checkResult

func record(tag string, pass bool, messages ...string) *checkResult {
	r := &checkResult{tag: tag, pass: pass, messages: messages}
	results = append(results, r)
	return r
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

func main() {
	specs, loadErr := loadAgentSpecs(agentsDir)
	if loadErr != nil {
		fmt.Fprintf(os.Stderr, "fatal: could not list agent files: %v\n", loadErr)
		os.Exit(1)
	}

	// The cross-file checks derive the role names from the agent files on
	// disk (filenames without .md), per the implementation guidance in the
	// task brief and docs/spec.md ART-3. VAL-14 additionally pins the
	// on-disk roster against the normative table in docs/spec.md §3, so
	// disk cannot silently drift from spec.
	expectedNames := make([]string, 0, len(specs))
	for _, s := range specs {
		expectedNames = append(expectedNames, s.filename)
	}
	sort.Strings(expectedNames)
	expectedSet := toSet(expectedNames)

	readme := mustRead(readmePath)
	design := mustRead(designPath)
	faq := mustRead(faqPath)
	cheatsheet := mustRead(cheatsheetPath)
	skill := mustRead(skillPath)
	install := mustRead(installPath)

	checkVAL1(specs)
	checkVAL2(specs)
	checkVAL3(specs)
	checkVAL4(specs)
	checkVAL5(specs)
	designAccess := parseDesignAccessTable(design)
	checkVAL6(specs, designAccess)
	checkVAL7(expectedNames, readme, skill, design, faq, cheatsheet)
	checkVAL8(specs, expectedNames, readme, design, cheatsheet)
	checkVAL9(skill, expectedSet)
	checkVAL10(skill, design, cheatsheet, expectedSet)
	checkVAL11(install, expectedSet)
	checkVAL12(readme, skill, faq, cheatsheet, expectedNames)
	checkVAL14(specs)

	printReport()

	for _, r := range results {
		if !r.pass {
			os.Exit(1)
		}
	}
	os.Exit(0)
}

// ---------------------------------------------------------------------------
// Loading agent files
// ---------------------------------------------------------------------------

func loadAgentSpecs(dir string) ([]*agentSpec, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var specs []*agentSpec
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".md") {
			continue
		}
		path := filepath.Join(dir, e.Name())
		raw, err := os.ReadFile(path)
		s := &agentSpec{
			filename: strings.TrimSuffix(e.Name(), ".md"),
			path:     path,
		}
		if err != nil {
			s.parseErr = fmt.Errorf("could not read %s: %w", path, err)
			specs = append(specs, s)
			continue
		}
		s.raw = string(raw)
		fm, body, ferr := splitFrontmatter(s.raw)
		if ferr != nil {
			s.parseErr = ferr
			specs = append(specs, s)
			continue
		}
		s.body = body
		var parsed frontmatter
		if yerr := yaml.Unmarshal([]byte(fm), &parsed); yerr != nil {
			s.parseErr = fmt.Errorf("YAML frontmatter did not parse: %w", yerr)
			specs = append(specs, s)
			continue
		}
		s.frontmatter = parsed
		specs = append(specs, s)
	}
	sort.Slice(specs, func(i, j int) bool { return specs[i].filename < specs[j].filename })
	return specs, nil
}

// splitFrontmatter splits a `---` fenced YAML frontmatter block from the
// following Markdown body, per docs/spec.md AGT-4 / VAL-1.
func splitFrontmatter(content string) (fm string, body string, err error) {
	lines := strings.Split(content, "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) != "---" {
		return "", "", fmt.Errorf("file does not start with a `---` frontmatter fence")
	}
	closeIdx := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			closeIdx = i
			break
		}
	}
	if closeIdx == -1 {
		return "", "", fmt.Errorf("no closing `---` fence found for frontmatter block")
	}
	fm = strings.Join(lines[1:closeIdx], "\n")
	body = strings.Join(lines[closeIdx+1:], "\n")
	return fm, body, nil
}

// ---------------------------------------------------------------------------
// VAL-1: parseable frontmatter + non-empty body
// ---------------------------------------------------------------------------

func checkVAL1(specs []*agentSpec) {
	var fails []string
	for _, s := range specs {
		if s.parseErr != nil {
			fails = append(fails, fmt.Sprintf("%s: %v", s.path, s.parseErr))
			continue
		}
		if strings.TrimSpace(s.body) == "" {
			fails = append(fails, fmt.Sprintf("%s: system-prompt body is empty", s.path))
		}
	}
	record("VAL-1", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-2: required fields present and non-blank
// ---------------------------------------------------------------------------

func checkVAL2(specs []*agentSpec) {
	var fails []string
	for _, s := range specs {
		if s.parseErr != nil {
			continue // already reported under VAL-1
		}
		fm := s.frontmatter
		if strings.TrimSpace(fm.Name) == "" {
			fails = append(fails, fmt.Sprintf("%s: missing/blank `name`", s.path))
		}
		if strings.TrimSpace(fm.Description) == "" {
			fails = append(fails, fmt.Sprintf("%s: missing/blank `description`", s.path))
		}
		if strings.TrimSpace(fm.Model) == "" {
			fails = append(fails, fmt.Sprintf("%s: missing/blank `model`", s.path))
		}
		if strings.TrimSpace(fm.Tools) == "" {
			fails = append(fails, fmt.Sprintf("%s: missing/blank `tools`", s.path))
		}
	}
	record("VAL-2", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-3: name == filename, unique across roster
// ---------------------------------------------------------------------------

func checkVAL3(specs []*agentSpec) {
	var fails []string
	seen := map[string][]string{}
	for _, s := range specs {
		if s.parseErr != nil {
			continue
		}
		name := strings.TrimSpace(s.frontmatter.Name)
		if name != s.filename {
			fails = append(fails, fmt.Sprintf("%s: frontmatter name %q does not match filename %q", s.path, name, s.filename))
		}
		seen[name] = append(seen[name], s.path)
	}
	for name, paths := range seen {
		if len(paths) > 1 {
			fails = append(fails, fmt.Sprintf("name %q is not unique across the roster: %s", name, strings.Join(paths, ", ")))
		}
	}
	record("VAL-3", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-4: model in {fable, opus, sonnet, haiku}
// ---------------------------------------------------------------------------

func checkVAL4(specs []*agentSpec) {
	var fails []string
	for _, s := range specs {
		if s.parseErr != nil {
			continue
		}
		m := strings.TrimSpace(s.frontmatter.Model)
		if m != "" && !allowedModels[m] {
			fails = append(fails, fmt.Sprintf("%s: model %q is not one of fable/opus/sonnet/haiku", s.path, m))
		}
	}
	record("VAL-4", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-5: effort valid when present; absent on Haiku roles
// ---------------------------------------------------------------------------

func checkVAL5(specs []*agentSpec) {
	var fails []string
	for _, s := range specs {
		if s.parseErr != nil {
			continue
		}
		effort := strings.TrimSpace(s.frontmatter.Effort)
		model := strings.TrimSpace(s.frontmatter.Model)
		if effort != "" && !allowedEfforts[effort] {
			fails = append(fails, fmt.Sprintf("%s: effort %q is not one of low/medium/high/xhigh/max", s.path, effort))
		}
		if model == "haiku" && effort != "" {
			fails = append(fails, fmt.Sprintf("%s: effort %q must be absent on Haiku role %q", s.path, effort, s.filename))
		}
	}
	record("VAL-5", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-6: tools well-formed, never `Agent`, derived access matches design.md
// ---------------------------------------------------------------------------

func parseToolTokens(tools string) []string {
	parts := strings.Split(tools, ",")
	tokens := make([]string, 0, len(parts))
	for _, p := range parts {
		t := strings.TrimSpace(p)
		if t == "" {
			continue
		}
		tokens = append(tokens, t)
	}
	return tokens
}

func checkVAL6(specs []*agentSpec, designAccess map[string]string) {
	var fails []string
	for _, s := range specs {
		if s.parseErr != nil {
			continue
		}
		tools := strings.TrimSpace(s.frontmatter.Tools)
		if tools == "" {
			continue // already reported under VAL-2
		}
		tokens := parseToolTokens(tools)
		if len(tokens) == 0 {
			fails = append(fails, fmt.Sprintf("%s: `tools` did not parse into any token", s.path))
			continue
		}
		malformed := false
		hasEdit, hasWrite, hasAgent := false, false, false
		for _, t := range tokens {
			if !toolTokenRe.MatchString(t) {
				fails = append(fails, fmt.Sprintf("%s: malformed tool token %q in `tools`", s.path, t))
				malformed = true
				continue
			}
			switch t {
			case "Edit":
				hasEdit = true
			case "Write":
				hasWrite = true
			case "Agent":
				hasAgent = true
			}
		}
		if hasAgent {
			fails = append(fails, fmt.Sprintf("%s: `tools` MUST NOT contain `Agent` (nested-delegation prohibition)", s.path))
		}
		if malformed {
			continue
		}

		derivedWritable := hasEdit || hasWrite
		derivedAccess := "read-only"
		if derivedWritable {
			derivedAccess = "writable"
		}

		expectedAccess, ok := designAccess[s.filename]
		if !ok {
			fails = append(fails, fmt.Sprintf("%s: docs/design.md Agent Roles table has no Access entry for role %q", s.path, s.filename))
			continue
		}
		if expectedAccess != derivedAccess {
			fails = append(fails, fmt.Sprintf(
				"%s: derived access class %q (from `tools`) does not match docs/design.md Access column %q for role %q",
				s.path, derivedAccess, expectedAccess, s.filename))
		}
	}
	record("VAL-6", len(fails) == 0, fails...)
}

// parseDesignAccessTable extracts the Access column of docs/design.md's
// "Agent Roles" Markdown table, keyed by role name (without backticks).
func parseDesignAccessTable(design string) map[string]string {
	lines := strings.Split(design, "\n")
	access := map[string]string{}
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if !strings.HasPrefix(trimmed, "|") {
			continue
		}
		if strings.Contains(trimmed, "Role") && strings.Contains(trimmed, "Access") &&
			strings.Contains(trimmed, "Model") && strings.Contains(trimmed, "Responsibility") {
			// Found the header row; the next line is the separator, then
			// data rows follow until a non-table line.
			for j := i + 2; j < len(lines); j++ {
				row := strings.TrimSpace(lines[j])
				if !strings.HasPrefix(row, "|") {
					break
				}
				cols := splitTableRow(row)
				if len(cols) < 2 {
					continue
				}
				name := extractBacktick(cols[0])
				if name == "" {
					continue
				}
				access[name] = strings.TrimSpace(cols[1])
			}
			break
		}
	}
	return access
}

func splitTableRow(row string) []string {
	trimmed := strings.Trim(row, "|")
	rawCols := strings.Split(trimmed, "|")
	cols := make([]string, len(rawCols))
	for i, c := range rawCols {
		cols[i] = strings.TrimSpace(c)
	}
	return cols
}

var backtickRe = regexp.MustCompile("`([^`]+)`")

// extractBacktick returns the content of the first backticked span in s, or
// "" if none is present.
func extractBacktick(s string) string {
	m := backtickRe.FindStringSubmatch(s)
	if m == nil {
		return ""
	}
	return m[1]
}

// extractAllBackticks returns the contents of every backticked span in s.
func extractAllBackticks(s string) []string {
	matches := backtickRe.FindAllStringSubmatch(s, -1)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		out = append(out, m[1])
	}
	return out
}

// ---------------------------------------------------------------------------
// VAL-7: README/SKILL/design/faq/cheatsheet each mention every configured
// agent name as a standalone identifier
// ---------------------------------------------------------------------------

// mentionsRole reports whether content mentions name as a standalone role
// identifier. An occurrence embedded in a longer identifier does not count:
// "doc-reviewer" must not satisfy a mention check for "reviewer", nor
// "fast-coding-worker" one for "coding-worker".
func mentionsRole(content, name string) bool {
	re := regexp.MustCompile(`(^|[^A-Za-z0-9_-])` + regexp.QuoteMeta(name) + `($|[^A-Za-z0-9_-])`)
	return re.MatchString(content)
}

func checkVAL7(names []string, readme, skill, design, faq, cheatsheet string) {
	var fails []string
	files := map[string]string{
		readmePath:     readme,
		skillPath:      skill,
		designPath:     design,
		faqPath:        faq,
		cheatsheetPath: cheatsheet,
	}
	// Deterministic iteration order for stable output.
	fileOrder := []string{readmePath, skillPath, designPath, faqPath, cheatsheetPath}
	for _, path := range fileOrder {
		content := files[path]
		for _, name := range names {
			if !mentionsRole(content, name) {
				fails = append(fails, fmt.Sprintf("%s: does not mention agent %q", path, name))
			}
		}
	}
	record("VAL-7", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-8: README.md, docs/design.md, and docs/cheatsheet.md document each
// agent with its model on one line.
// ---------------------------------------------------------------------------

func modelTierWord(alias string) string {
	if alias == "" {
		return ""
	}
	return strings.ToUpper(alias[:1]) + alias[1:]
}

func checkVAL8(specs []*agentSpec, names []string, readme, design, cheatsheet string) {
	var fails []string
	modelByName := map[string]string{}
	for _, s := range specs {
		if s.parseErr != nil {
			continue
		}
		modelByName[s.filename] = strings.TrimSpace(s.frontmatter.Model)
	}

	files := map[string]string{readmePath: readme, designPath: design, cheatsheetPath: cheatsheet}
	fileOrder := []string{readmePath, designPath, cheatsheetPath}
	for _, path := range fileOrder {
		lines := strings.Split(files[path], "\n")
		for _, name := range names {
			alias := modelByName[name]
			if alias == "" {
				continue // already reported under VAL-2/VAL-4
			}
			tier := modelTierWord(alias)
			found := false
			for _, line := range lines {
				if mentionsRole(line, name) && (strings.Contains(line, alias) || strings.Contains(line, tier)) {
					found = true
					break
				}
			}
			if !found {
				fails = append(fails, fmt.Sprintf(
					"%s: no single line documents agent %q together with its model (%q or %q)",
					path, name, alias, tier))
			}
		}
	}
	record("VAL-8", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-9: SKILL.md's dispatch list matches the agent files exactly
// ---------------------------------------------------------------------------

var dispatchBulletRe = regexp.MustCompile("^-\\s*`([a-z0-9-]+)`\\s*—")

func checkVAL9(skill string, expectedSet map[string]bool) {
	lines := strings.Split(skill, "\n")
	headingIdx := -1
	for i, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "#") && strings.Contains(strings.ToLower(trimmed), "dispatch list") {
			headingIdx = i
			break
		}
	}
	if headingIdx == -1 {
		record("VAL-9", false, fmt.Sprintf("%s: no heading containing \"dispatch list\" found", skillPath))
		return
	}

	found := map[string]bool{}
	for i := headingIdx + 1; i < len(lines); i++ {
		trimmed := strings.TrimSpace(lines[i])
		if strings.HasPrefix(trimmed, "#") {
			break // next section
		}
		m := dispatchBulletRe.FindStringSubmatch(trimmed)
		if m != nil {
			found[m[1]] = true
		}
	}

	var fails []string
	for name := range expectedSet {
		if !found[name] {
			fails = append(fails, fmt.Sprintf("%s: dispatch list is missing bullet for agent %q", skillPath, name))
		}
	}
	for name := range found {
		if !expectedSet[name] {
			fails = append(fails, fmt.Sprintf("%s: dispatch list bullet %q does not match any agent file", skillPath, name))
		}
	}
	sort.Strings(fails)
	record("VAL-9", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-10: pattern registries in SKILL.md, docs/design.md, and
// docs/cheatsheet.md match; every referenced role exists as an agent file.
// ---------------------------------------------------------------------------

const patternTableHeader = "| Pattern | Triggers | Roles used |"

// parsePatternTable extracts (pattern name -> roles-used cell) from the
// first "| Pattern | Triggers | Roles used |" table found in content.
func parsePatternTable(content string) map[string]string {
	lines := strings.Split(content, "\n")
	table := map[string]string{}
	for i, line := range lines {
		if strings.TrimSpace(line) != patternTableHeader {
			continue
		}
		for j := i + 2; j < len(lines); j++ {
			row := strings.TrimSpace(lines[j])
			if !strings.HasPrefix(row, "|") {
				break
			}
			cols := splitTableRow(row)
			if len(cols) < 3 {
				continue
			}
			name := extractBacktick(cols[0])
			if name == "" {
				continue
			}
			table[name] = cols[2]
		}
		break
	}
	return table
}

func checkVAL10(skill, design, cheatsheet string, expectedSet map[string]bool) {
	var fails []string

	sources := []struct {
		path     string
		patterns map[string]string
	}{
		{skillPath, parsePatternTable(skill)},
		{designPath, parsePatternTable(design)},
		{cheatsheetPath, parsePatternTable(cheatsheet)},
	}

	for _, src := range sources {
		if len(src.patterns) == 0 {
			fails = append(fails, fmt.Sprintf("%s: no pattern registry table found (header %q)", src.path, patternTableHeader))
		}
	}

	// The registries must list the same pattern names in every source.
	for _, a := range sources {
		for _, b := range sources {
			if a.path == b.path {
				continue
			}
			for name := range a.patterns {
				if _, ok := b.patterns[name]; !ok {
					fails = append(fails, fmt.Sprintf("pattern %q appears in %s but not in %s", name, a.path, b.path))
				}
			}
		}
	}

	// Every backticked token in a "Roles used" cell that is itself shaped
	// like a role name (roleNameRe) and is one of the ten known role names
	// must exist as an agent file. Non-role phrases such as "all roles" are
	// not backticked and are ignored by construction.
	for _, src := range sources {
		for pattern, cell := range src.patterns {
			for _, tok := range extractAllBackticks(cell) {
				if !roleNameRe.MatchString(tok) {
					continue
				}
				if !expectedSet[tok] {
					fails = append(fails, fmt.Sprintf(
						"%s: pattern %q references role `%s` which is not an existing agent file", src.path, pattern, tok))
				}
			}
		}
	}

	sort.Strings(fails)
	record("VAL-10", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-11: scripts/install.sh's embedded agent list matches the agent files
// ---------------------------------------------------------------------------

var arrayLineRe = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)

func checkVAL11(install string, expectedSet map[string]bool) {
	lines := strings.Split(install, "\n")
	startIdx := -1
	for i, line := range lines {
		if strings.Contains(line, "AGENTS=(") {
			startIdx = i
			break
		}
	}
	if startIdx == -1 {
		record("VAL-11", false, fmt.Sprintf("%s: no `AGENTS=( ... )` array literal found", installPath))
		return
	}

	found := map[string]bool{}
	// Handle the case where entries start on the same line as `AGENTS=(`.
	afterParen := lines[startIdx][strings.Index(lines[startIdx], "AGENTS=(")+len("AGENTS=("):]
	scanLineForEntries(afterParen, found)

	closed := strings.Contains(afterParen, ")")
	for i := startIdx + 1; !closed && i < len(lines); i++ {
		line := lines[i]
		if strings.Contains(line, ")") {
			closed = true
			line = line[:strings.Index(line, ")")]
		}
		scanLineForEntries(line, found)
	}

	var fails []string
	for name := range expectedSet {
		if !found[name] {
			fails = append(fails, fmt.Sprintf("%s: AGENTS array is missing agent %q", installPath, name))
		}
	}
	for name := range found {
		if !expectedSet[name] {
			fails = append(fails, fmt.Sprintf("%s: AGENTS array lists %q, which does not match any agent file", installPath, name))
		}
	}
	sort.Strings(fails)
	record("VAL-11", len(fails) == 0, fails...)
}

func scanLineForEntries(line string, found map[string]bool) {
	// Strip bash comments.
	if idx := strings.Index(line, "#"); idx >= 0 {
		line = line[:idx]
	}
	tok := strings.TrimSpace(line)
	if tok == "" {
		return
	}
	if arrayLineRe.MatchString(tok) {
		found[tok] = true
	}
}

// ---------------------------------------------------------------------------
// VAL-12: no deprecated snake_case role identifiers in primary docs
// ---------------------------------------------------------------------------

// checkVAL12 intentionally scopes its scan to README.md, SKILL.md,
// docs/faq.md, and docs/cheatsheet.md only. docs/design.md is excluded
// because it legitimately discusses the Codex snake_case -> Claude
// kebab-case naming mapping (e.g. "coding_worker" as the Agenticons/Codex
// identifier being translated), and docs/spec.md is excluded for the same
// reason (it documents the mapping too). Scanning those files would produce
// false positives on prose that is *about* the deprecated identifiers
// rather than *using* them as live identifiers. The literal filename
// "validate_package" (this script) is not a role identifier and must never
// be flagged.
func checkVAL12(readme, skill, faq, cheatsheet string, names []string) {
	var fails []string
	files := map[string]string{readmePath: readme, skillPath: skill, faqPath: faq, cheatsheetPath: cheatsheet}
	fileOrder := []string{readmePath, skillPath, faqPath, cheatsheetPath}
	for _, path := range fileOrder {
		content := files[path]
		for _, name := range names {
			deprecated := strings.ReplaceAll(name, "-", "_")
			if deprecated == name {
				continue // no hyphen to translate
			}
			if strings.Contains(content, deprecated) {
				fails = append(fails, fmt.Sprintf("%s: contains deprecated snake_case identifier %q", path, deprecated))
			}
		}
	}
	record("VAL-12", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// VAL-14: the on-disk roster matches the normative table in docs/spec.md §3
// exactly — the same ten role names and, per role, the pinned model, effort,
// and derived access class (AGT-1, ART-3). The other checks derive the
// roster from disk; this one keeps disk honest against the spec, so a role
// cannot be added, dropped, or moved to another tier without a deliberate
// spec (and validator) change.
// ---------------------------------------------------------------------------

type rosterEntry struct {
	model    string
	effort   string // "" means the effort field must be omitted (Haiku roles)
	writable bool
}

// expectedRoster mirrors docs/spec.md §3 AGT-1. Changing it is a contract
// change: update the spec table and every doc the validator checks in the
// same commit.
var expectedRoster = map[string]rosterEntry{
	"planner":            {model: "fable", effort: "xhigh", writable: false},
	"coding-worker":      {model: "sonnet", effort: "high", writable: true},
	"fast-coding-worker": {model: "haiku", effort: "", writable: true},
	"helper-worker":      {model: "haiku", effort: "", writable: false},
	"forensic-analyst":   {model: "fable", effort: "xhigh", writable: false},
	"doc-reviewer":       {model: "sonnet", effort: "medium", writable: false},
	"reviewer":           {model: "opus", effort: "high", writable: false},
	"qa-engineer":        {model: "sonnet", effort: "high", writable: true},
	"edge-case-analyst":  {model: "opus", effort: "high", writable: false},
	"advisor":            {model: "fable", effort: "xhigh", writable: false},
}

func checkVAL14(specs []*agentSpec) {
	var fails []string
	seen := map[string]bool{}
	for _, s := range specs {
		if s.parseErr != nil {
			continue // already reported under VAL-1
		}
		seen[s.filename] = true
		want, ok := expectedRoster[s.filename]
		if !ok {
			fails = append(fails, fmt.Sprintf("%s: role %q is not in the normative roster (docs/spec.md §3)", s.path, s.filename))
			continue
		}
		if got := strings.TrimSpace(s.frontmatter.Model); got != want.model {
			fails = append(fails, fmt.Sprintf("%s: model %q does not match the normative roster (%q)", s.path, got, want.model))
		}
		if got := strings.TrimSpace(s.frontmatter.Effort); got != want.effort {
			if want.effort == "" {
				fails = append(fails, fmt.Sprintf("%s: effort %q must be omitted per the normative roster", s.path, got))
			} else {
				fails = append(fails, fmt.Sprintf("%s: effort %q does not match the normative roster (%q)", s.path, got, want.effort))
			}
		}
		writable := false
		for _, tok := range parseToolTokens(s.frontmatter.Tools) {
			if tok == "Edit" || tok == "Write" {
				writable = true
			}
		}
		if writable != want.writable {
			wantClass, gotClass := "read-only", "read-only"
			if want.writable {
				wantClass = "writable"
			}
			if writable {
				gotClass = "writable"
			}
			fails = append(fails, fmt.Sprintf("%s: derived access class %q does not match the normative roster (%q)", s.path, gotClass, wantClass))
		}
	}
	for name := range expectedRoster {
		if !seen[name] {
			fails = append(fails, fmt.Sprintf("%s/%s.md: normative roster role %q has no agent file on disk", agentsDir, name, name))
		}
	}
	sort.Strings(fails)
	record("VAL-14", len(fails) == 0, fails...)
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

func toSet(names []string) map[string]bool {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	return set
}

func mustRead(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintf(os.Stderr, "fatal: could not read %s: %v\n", path, err)
		os.Exit(1)
	}
	return string(b)
}

// ---------------------------------------------------------------------------
// Reporting (VAL-13)
// ---------------------------------------------------------------------------

func printReport() {
	fmt.Println("Autobots package validation")
	fmt.Println("============================")
	allPass := true
	for _, r := range results {
		status := "PASS"
		if !r.pass {
			status = "FAIL"
			allPass = false
		}
		fmt.Printf("[%s] %s\n", status, r.tag)
		for _, m := range r.messages {
			fmt.Printf("       - %s\n", m)
		}
	}
	fmt.Println("============================")
	if allPass {
		fmt.Println("All checks passed.")
	} else {
		fmt.Println("One or more checks FAILED. See details above.")
	}
}
