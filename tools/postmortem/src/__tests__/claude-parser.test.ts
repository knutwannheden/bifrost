import { describe, expect, it } from 'vitest';
import { extractTokenTimeline, extractToolEvents, normalizePath, parseClaudeTranscript } from '../claude-parser.js';

function makeAssistant(
  content: unknown[],
  usage = { input_tokens: 1000, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  timestamp = '2026-01-01T00:00:00Z',
) {
  return JSON.stringify({
    type: 'assistant',
    message: { content, usage },
    timestamp,
  });
}

function makeUser(content: unknown[], timestamp = '2026-01-01T00:00:01Z') {
  return JSON.stringify({
    type: 'user',
    message: { content },
    timestamp,
  });
}

function makeToolUse(name: string, input: Record<string, unknown>, id = 'toolu_1') {
  return { type: 'tool_use', id, name, input };
}

function makeToolResult(toolUseId: string, content: string, isError = false) {
  return { type: 'tool_result', tool_use_id: toolUseId, content, is_error: isError };
}

describe('parseClaudeTranscript', () => {
  it('parses JSONL lines into entries', () => {
    const lines = [
      JSON.stringify({ type: 'summary', message: 'session start' }),
      makeAssistant([{ type: 'text', text: 'hello' }]),
      makeUser([{ type: 'text', text: 'do something' }]),
    ];
    const entries = parseClaudeTranscript(lines.join('\n'));
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe('summary');
    expect(entries[1].type).toBe('assistant');
    expect(entries[2].type).toBe('user');
  });

  it('skips compact summaries', () => {
    const lines = [
      JSON.stringify({
        type: 'assistant',
        isCompactSummary: true,
        message: { content: [{ type: 'text', text: 'summary' }] },
        timestamp: '2026-01-01T00:00:00Z',
      }),
      makeAssistant([{ type: 'text', text: 'real' }]),
    ];
    const entries = parseClaudeTranscript(lines.join('\n'));
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe('assistant');
  });

  it('handles empty and malformed lines gracefully', () => {
    const lines = ['', 'not json', makeAssistant([{ type: 'text', text: 'ok' }])];
    const entries = parseClaudeTranscript(lines.join('\n'));
    expect(entries).toHaveLength(1);
  });
});

describe('extractToolEvents', () => {
  it('joins tool_use with tool_result by id', () => {
    const assistantLine = makeAssistant(
      [makeToolUse('Read', { file_path: '/home/user/project/src/utils.ts' }, 'toolu_abc')],
      undefined,
      '2026-01-01T00:00:00Z',
    );
    const userLine = makeUser([makeToolResult('toolu_abc', 'file contents here')], '2026-01-01T00:00:01Z');
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events).toHaveLength(1);
    expect(events[0].toolName).toBe('Read');
    expect(events[0].category).toBe('navigation');
    expect(events[0].isError).toBe(false);
    expect(events[0].resultText).toBe('file contents here');
    expect(events[0].filePath).toBe('src/utils.ts');
  });

  it('categorizes Write as mutation with writtenContent', () => {
    const assistantLine = makeAssistant([
      makeToolUse('Write', { file_path: '/project/src/new.ts', content: 'const x = 1;' }, 'toolu_w'),
    ]);
    const userLine = makeUser([makeToolResult('toolu_w', 'File written')]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events[0].category).toBe('mutation');
    expect(events[0].writtenContent).toBe('const x = 1;');
  });

  it('categorizes Edit as mutation with writtenContent from new_string', () => {
    const assistantLine = makeAssistant([
      makeToolUse('Edit', { file_path: '/project/src/a.ts', old_string: 'old', new_string: 'new' }, 'toolu_e'),
    ]);
    const userLine = makeUser([makeToolResult('toolu_e', 'Edit applied')]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events[0].category).toBe('mutation');
    expect(events[0].writtenContent).toBe('new');
  });

  it('categorizes Bash test commands as test', () => {
    const assistantLine = makeAssistant([makeToolUse('Bash', { command: 'npm test' }, 'toolu_t')]);
    const userLine = makeUser([makeToolResult('toolu_t', 'PASS all tests')]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events[0].category).toBe('test');
  });

  it('categorizes Bash write commands as mutation', () => {
    const assistantLine = makeAssistant([makeToolUse('Bash', { command: "echo 'hello' > output.txt" }, 'toolu_bw')]);
    const userLine = makeUser([makeToolResult('toolu_bw', '')]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events[0].category).toBe('mutation');
  });

  it('marks error tool results', () => {
    const assistantLine = makeAssistant([makeToolUse('Read', { file_path: '/project/missing.ts' }, 'toolu_err')]);
    const userLine = makeUser([makeToolResult('toolu_err', 'File not found', true)]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events[0].isError).toBe(true);
  });

  it('handles tool_result content as array of text blocks', () => {
    const assistantLine = makeAssistant([makeToolUse('Read', { file_path: '/project/a.ts' }, 'toolu_arr')]);
    const userLine = makeUser([
      {
        type: 'tool_result',
        tool_use_id: 'toolu_arr',
        content: [
          { type: 'text', text: 'part1' },
          { type: 'text', text: 'part2' },
        ],
        is_error: false,
      },
    ]);
    const _entries = parseClaudeTranscript(
      [
        assistantLine,
        JSON.stringify({ type: 'user', message: { content: [userLine[0]] }, timestamp: '2026-01-01T00:00:01Z' }),
      ].join('\n'),
    );

    // Re-do properly
    const line1 = makeAssistant([makeToolUse('Read', { file_path: '/project/a.ts' }, 'toolu_arr')]);
    const line2 = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_arr',
            content: [
              { type: 'text', text: 'part1' },
              { type: 'text', text: 'part2' },
            ],
            is_error: false,
          },
        ],
      },
      timestamp: '2026-01-01T00:00:01Z',
    });
    const entries2 = parseClaudeTranscript([line1, line2].join('\n'));
    const events = extractToolEvents(entries2);

    expect(events[0].resultText).toBe('part1part2');
  });

  it('handles multiple tool uses in one assistant message', () => {
    const assistantLine = makeAssistant([
      makeToolUse('Read', { file_path: '/Users/knut/project/a.ts' }, 'toolu_1'),
      makeToolUse('Read', { file_path: '/Users/knut/project/b.ts' }, 'toolu_2'),
    ]);
    const userLine = makeUser([makeToolResult('toolu_1', 'content a'), makeToolResult('toolu_2', 'content b')]);
    const entries = parseClaudeTranscript([assistantLine, userLine].join('\n'));
    const events = extractToolEvents(entries);

    expect(events).toHaveLength(2);
    expect(events[0].filePath).toBe('a.ts');
    expect(events[1].filePath).toBe('b.ts');
  });
});

describe('extractTokenTimeline', () => {
  it('extracts token usage from assistant entries (inputTokens includes cache)', () => {
    const lines = [
      makeAssistant(
        [{ type: 'text', text: 'hello' }],
        { input_tokens: 5000, output_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 300 },
        '2026-01-01T00:00:00Z',
      ),
      makeAssistant(
        [{ type: 'text', text: 'world' }],
        { input_tokens: 8000, output_tokens: 500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        '2026-01-01T00:01:00Z',
      ),
    ];
    const entries = parseClaudeTranscript(lines.join('\n'));
    const timeline = extractTokenTimeline(entries);

    expect(timeline.turns).toHaveLength(2);
    // inputTokens = input + cache_creation + cache_read
    expect(timeline.turns[0].inputTokens).toBe(5500); // 5000 + 200 + 300
    expect(timeline.turns[1].inputTokens).toBe(8000); // 8000 + 0 + 0
    expect(timeline.totalInputTokens).toBe(13500);
    expect(timeline.totalOutputTokens).toBe(1500);
    // cost-weighted: nonCached + cache_creation*1.25 + cache_read*0.1 + output*5
    // Turn 0: 5000 + 200*1.25 + 300*0.1 + 1000*5 = 5000 + 250 + 30 + 5000 = 10280
    // Turn 1: 8000 + 0 + 0 + 500*5 = 10500
    expect(timeline.totalCostWeightedTokens).toBe(20780);
  });

  it('skips entries without usage', () => {
    const lines = [
      JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: '2026-01-01T00:00:00Z' }),
      makeAssistant([{ type: 'text', text: 'hello' }]),
    ];
    const entries = parseClaudeTranscript(lines.join('\n'));
    const timeline = extractTokenTimeline(entries);

    expect(timeline.turns).toHaveLength(1);
  });
});

describe('normalizePath', () => {
  it('strips /Users/*/.../ prefix and produces repo-relative path', () => {
    expect(normalizePath('/Users/knut/project/src/utils.ts')).toBe('src/utils.ts');
  });

  it('strips /home/*/.../ prefix', () => {
    expect(normalizePath('/home/user/myproject/lib/main.ts')).toBe('lib/main.ts');
  });

  it('strips leading ./', () => {
    expect(normalizePath('./src/utils.ts')).toBe('src/utils.ts');
  });

  it('returns relative paths unchanged', () => {
    expect(normalizePath('src/utils.ts')).toBe('src/utils.ts');
  });

  it('uses cwd to relativize when provided', () => {
    expect(normalizePath('/Users/knut/project/src/utils.ts', '/Users/knut/project')).toBe('src/utils.ts');
  });
});
