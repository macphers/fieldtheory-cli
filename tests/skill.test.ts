import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { skillWithFrontmatter, skillBody, installSkill } from '../src/skill.js';

describe('skill content', () => {
  it('skillWithFrontmatter includes YAML frontmatter', () => {
    const content = skillWithFrontmatter();
    assert.ok(content.startsWith('---\n'));
    assert.ok(content.includes('name: fieldtheory'));
    assert.ok(content.includes('description:'));
    // Frontmatter closes
    assert.ok(content.indexOf('---', 4) > 0);
  });

  it('skillBody has no frontmatter', () => {
    const content = skillBody();
    assert.ok(!content.startsWith('---'));
    assert.ok(content.startsWith('# Field Theory'));
  });

  it('both versions include key commands', () => {
    for (const content of [skillWithFrontmatter(), skillBody()]) {
      assert.ok(content.includes('ft paths --json'));
      assert.ok(content.includes('ft status --json'));
      assert.ok(content.includes('ft current update --file <tmp>'));
      assert.ok(content.includes('ft search'));
      assert.ok(content.includes('ft list'));
      assert.ok(content.includes('ft stats'));
      assert.ok(content.includes('ft show'));
      assert.ok(content.includes('ft seeds search'));
      assert.ok(content.includes('ft possible run'));
      assert.ok(content.includes('ft possible grid'));
      assert.ok(content.includes('ft possible prompt'));
      assert.ok(content.includes('ft possible nightly install'));
      assert.ok(content.includes('ft library search'));
      assert.ok(content.includes('ft library show'));
      assert.ok(content.includes('ft commands list'));
      assert.ok(content.includes('ft commands validate'));
    }
  });

  it('skill teaches natural-language roadmap requests', () => {
    const content = skillWithFrontmatter();
    assert.ok(content.includes('XYZ type of bookmarks'));
    assert.ok(content.includes('roadmap plotted in the grid'));
    assert.ok(content.includes('these projects'));
    assert.ok(content.includes('generate -> critique -> score'));
  });

  it('skill teaches active document edit workflow', () => {
    const content = skillWithFrontmatter();
    assert.ok(content.includes('commands.readContent'));
    assert.ok(content.includes('ft current --content-only'));
    assert.ok(content.includes('ft current update --file <temp-file>'));
    assert.ok(content.includes('ft current update --pipe <command>'));
    assert.ok(content.includes('ft current update --pipe "sed \'s/^- /- [ ] /\'"'));
    assert.ok(content.includes('never run `cat`, `sed`, or another shell command against `activeDocument.path`'));
  });

  it('force install overwrites stale Codex instructions', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-skill-home-'));
    const previousHome = process.env.HOME;
    try {
      const instructionsDir = path.join(homeDir, '.codex', 'instructions');
      fs.mkdirSync(instructionsDir, { recursive: true });
      const installPath = path.join(instructionsDir, 'fieldtheory.md');
      fs.writeFileSync(installPath, '# old bookmark-only skill\n');
      process.env.HOME = homeDir;

      const results = await installSkill({ force: true });

      assert.deepEqual(results, [{
        agent: 'Codex',
        path: installPath,
        action: 'updated',
      }]);
      assert.equal(fs.readFileSync(installPath, 'utf-8'), skillBody());
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(homeDir, { recursive: true, force: true });
    }
  });

  it('skill content ends with newline', () => {
    assert.ok(skillWithFrontmatter().endsWith('\n'));
    assert.ok(skillBody().endsWith('\n'));
  });
});
