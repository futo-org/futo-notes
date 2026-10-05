import { describe, expect, it } from 'vitest';

import { decide, scratchDirFor } from './subagent-scratch.mjs';

describe('scratchDirFor', () => {
  it('is distinct per agent within a session and stable for the same agent', () => {
    const a = scratchDirFor({ sessionId: 's1', agentId: 'a1', tmpdir: '/tmp', uid: 1000 });
    const b = scratchDirFor({ sessionId: 's1', agentId: 'a2', tmpdir: '/tmp', uid: 1000 });
    expect(a).not.toBe(b);
    expect(a).toBe(scratchDirFor({ sessionId: 's1', agentId: 'a1', tmpdir: '/tmp', uid: 1000 }));
    expect(a).toBe('/tmp/claude-1000/futo-agent-scratch/s1/a1');
  });

  it('sanitizes ids so a hostile id cannot escape the tree', () => {
    const dir = scratchDirFor({ sessionId: '../../etc', agentId: 'x/y', tmpdir: '/tmp', uid: 1 });
    expect(dir.startsWith('/tmp/claude-1/futo-agent-scratch/')).toBe(true);
    expect(dir).not.toContain('..');
  });
});

describe('decide', () => {
  it('creates the directory and tells the agent where it is', () => {
    const made = [];
    const decision = decide(
      { session_id: 'sess', agent_id: 'agent-7', agent_type: 'fixer' },
      { mkdir: (p) => made.push(p) },
    );
    expect(made).toHaveLength(1);
    expect(made[0]).toContain('/futo-agent-scratch/sess/agent-7');
    expect(decision.hookSpecificOutput.hookEventName).toBe('SubagentStart');
    expect(decision.hookSpecificOutput.additionalContext).toContain(made[0]);
  });
});
