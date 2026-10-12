#!/usr/bin/env ruby
# frozen_string_literal: true

# Counts the main agent's project-file writes inside autobots flows across
# ~/.claude/projects/*/*.jsonl Claude Code transcripts.
#
# A flow starts at an autobots Skill call, at an /autobots user prompt, or at an
# autobots-progress call made outside a flow. It ends at a progress call with
# finished: true, at the next start, or at the transcript's end. Subagent lines
# (isSidechain) are skipped. A write counts only when its target is inside the
# transcript's cwd, which is the project directory.
#
# Output holds counts only. The script never prints or writes prompt, command,
# or file text.
#
# Usage:
#   ruby scripts/autobots_flow_scan.rb [--since YYYY-MM-DD]
#     --since  count only transcripts modified on or after this date

require 'json'
require 'optparse'
require 'optparse/date'

PROGRESS = 'mcp__autobots-progress__progress'
FILE_TOOLS = %w[Edit Write NotebookEdit MultiEdit].freeze
TMP = %r{\A(/private)?/tmp(/|\z)|\A/var/folders(/|\z)}
CLAUDE_DIR = File.expand_path('~/.claude')

def new_flow = { edits: 0, bash: 0, agents: 0, uses: 0, finished: false }

def open_flow(flows) = new_flow.tap { flows << _1 }

# A start that follows a flow with no tool use yet (e.g. the /autobots prompt
# followed by its Skill call) continues that flow instead of opening another.
def start_flow(flows, flow)
  return flow if flow && flow[:uses].zero?

  open_flow(flows)
end

def autobots_skill?(skill) = skill.to_s == 'autobots' || skill.to_s.end_with?(':autobots')

def autobots_prompt?(line)
  content = line.dig('message', 'content')
  text = if content.is_a?(String)
           content
         else
           Array(content).filter_map { _1['text'] if _1.is_a?(Hash) && _1['type'] == 'text' }.join("\n")
         end
  text.include?('<command-name>/autobots</command-name>') || text.lstrip.match?(%r{\A/autobots(?![\w-])})
end

def inside?(path, cwd) = path == cwd || path.start_with?("#{cwd}/")

# Targets of a Bash command's write form, or [] when it has none. Best effort:
# single-quoted text (sed/perl scripts, echo bodies) is dropped and double
# quotes are stripped. git apply and patch write the working tree, so they
# target cwd ('.').
def bash_targets(command)
  clean = command.gsub(%r{<<-?\s*'?(\w+)'?.*?^\s*\1\s*$}m, ' ').gsub(/'[^']*'/, ' ').delete('"')
  targets = clean.scan(/(?<![=<>-])>>?\s*([^\s|;&<>()]+)/).flatten
  clean.split(/[;&|\n]+/).each do |segment|
    words = segment.split
    i = words.index { |w| %w[tee cp mv rm sed perl ruby patch git].include?(w) } or next
    args = words[(i + 1)..].reject { _1.start_with?('-') }
    case words[i]
    when 'cp', 'mv' then targets << args.last if args.any?
    when 'tee', 'rm' then targets.concat(args)
    when 'sed', 'perl', 'ruby'
      targets.concat(args) if words[(i + 1)..].any? { _1.match?(/\A-[a-zA-Z]*i(\.\S*)?\z/) }
    when 'patch' then targets << '.'
    when 'git'
      case args.first
      when 'apply' then targets << '.'
      when 'restore' then targets.concat(args.drop(1))
      when 'checkout'
        targets.concat(args.drop(args.index('--') + 1)) if args.include?('--')
      end
    end
  end
  targets
end

# A Bash target is a project write unless it is /dev/null, a temp or scratch
# path, a ~/.claude path, or a shell-variable path ($VAR, usually a scratch dir
# set earlier in the command). Relative targets resolve against cwd.
def project_target?(target, cwd)
  return false if target.empty? || target == '/dev/null' || target.include?('$')
  return false if target.start_with?('~') && !target.start_with?('~/')

  path = File.expand_path(target, cwd)
  return false if path.match?(TMP) || path.include?('scratchpad') || path.start_with?("#{CLAUDE_DIR}/")

  inside?(path, cwd)
end

def count_tool(flow, name, input, cwd)
  if FILE_TOOLS.include?(name)
    path = (input['file_path'] || input['notebook_path']).to_s
    flow[:edits] += 1 if !path.empty? && inside?(File.expand_path(path, cwd), cwd)
  elsif name == 'Bash'
    flow[:bash] += 1 if bash_targets(input['command'].to_s).any? { project_target?(_1, cwd) }
  elsif name == 'Agent'
    flow[:agents] += 1
  end
end

# Returns every flow found in one transcript.
def scan_transcript(path)
  flows = []
  flow = nil
  File.foreach(path) do |line|
    d = JSON.parse(line) rescue next
    next if d['isSidechain']

    if d['type'] == 'user'
      flow = start_flow(flows, flow) if autobots_prompt?(d)
      next
    end
    next unless d['type'] == 'assistant' && d['cwd'].is_a?(String)

    content = d.dig('message', 'content')
    next unless content.is_a?(Array)

    content.each do |b|
      next unless b['type'] == 'tool_use'

      name, input = b['name'], b['input'] || {}
      if name == 'Skill' && autobots_skill?(input['skill'])
        flow = start_flow(flows, flow)
      elsif name == PROGRESS
        flow ||= open_flow(flows)
        if input['finished'] == true
          flow[:finished] = true
          flow = nil
        end
      elsif flow
        flow[:uses] += 1
        count_tool(flow, name, input, d['cwd'])
      end
    end
  end
  flows
end

since = nil
OptionParser.new do |o|
  o.banner = 'usage: autobots_flow_scan.rb [--since YYYY-MM-DD]'
  o.on('--since DATE', Date, 'count only transcripts modified on or after DATE') { since = _1.to_time }
end.parse!(ARGV)

transcripts = Dir.glob(File.expand_path('~/.claude/projects/*/*.jsonl'))
transcripts.reject! { File.basename(File.dirname(_1)).match?(/role-eval|scratchpad/) }
transcripts.select! { File.mtime(_1) >= since } if since
flows = transcripts.flat_map { scan_transcript(_1) }

puts "transcripts: #{transcripts.size}"
puts "flows: #{flows.size}"
puts "flows finished: #{flows.count { _1[:finished] }}"
puts "flows with any project edit: #{flows.count { _1[:edits] + _1[:bash] > 0 }}"
puts "project Edit/Write calls: #{flows.sum { _1[:edits] }}"
puts "project Bash writes: #{flows.sum { _1[:bash] }}"
puts "flows with Agent calls: #{flows.count { _1[:agents] > 0 }}"
puts 'per-flow edits,bash,agents:'
puts flows.map { "#{_1[:edits]},#{_1[:bash]},#{_1[:agents]}" }.join(' ')
