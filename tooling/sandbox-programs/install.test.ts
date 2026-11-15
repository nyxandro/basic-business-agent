import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launcherScript, listedPackages, packagesOfSimulation } from './install.ts';

describe('programs of the sandbox without root', () => {
  it('reads the list and what apt would install', () => {
    expect(listedPackages('# comment\npandoc\n\n  qpdf  \n# fonts\nfonts-liberation2\n')).toEqual(['pandoc', 'qpdf', 'fonts-liberation2']);
    const simulation = 'NOTE: This is only a simulation!\nInst libqpdf30 (12.3.2-1 Ubuntu:26.04/resolute [amd64])\nInst qpdf (12.3.2-1 Ubuntu:26.04/resolute [amd64])\nConf qpdf (12.3.2-1)\n';
    expect(packagesOfSimulation(simulation)).toEqual(['libqpdf30', 'qpdf']);
  });

  // The repository usually lives in a folder with spaces («basic business agent»).
  it('writes a launcher that runs the program with its libraries and data, whatever the folder is called', () => {
    const dir = mkdtempSync(join(tmpdir(), "bba launcher's "));
    try {
      const program = join(dir, 'prog');
      writeFileSync(program, '#!/bin/sh\necho "$LD_LIBRARY_PATH|$FONTCONFIG_FILE|$TESSDATA_PREFIX|$pandoc_datadir|$1"\n');
      chmodSync(program, 0o755);
      const launcher = join(dir, 'launcher');
      writeFileSync(launcher, launcherScript(program, { libraryDirs: [join(dir, 'lib a'), join(dir, 'lib b')], fontsConf: join(dir, 'fonts.conf'), tessdata: join(dir, 'tess'), pandocData: null }));
      chmodSync(launcher, 0o755);
      const out = execFileSync(launcher, ['два слова'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LD_LIBRARY_PATH: '/host' } }).trim();
      expect(out).toBe(`${join(dir, 'lib a')}:${join(dir, 'lib b')}:/host|${join(dir, 'fonts.conf')}|${join(dir, 'tess')}||два слова`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
