import { describe, expect, it } from 'vite-plus/test';
import { parseCliArguments } from './index.ts';

describe('CLI capability grammar', () => {
  it('parses inspect and JSON mode', () => {
    const parsed = parseCliArguments(['inspect', 'https://www.instagram.com/p/example/', '--json']);
    expect(parsed.json).toBe(true);
    expect(parsed.command).toMatchObject({
      _tag: 'Inspect',
      sourceUrl: 'https://www.instagram.com/p/example/',
    });
  });

  it.each([
    ['direct', [], 'DirectExport'],
    ['frame', ['--at', '7'], 'FrameExport'],
    ['silent', ['--reencode', 'allow'], 'SilentExport'],
  ])('parses the %s export mode', (mode, options, expectedTag) => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--item',
      '2',
      '--mode',
      mode,
      ...options,
    ]);
    expect(parsed.command._tag).toBe('Export');
    if (parsed.command._tag !== 'Export') return;
    expect(parsed.command.operations[0]).toMatchObject({
      itemNumber: 2,
      mode: { _tag: expectedTag },
    });
  });

  it.each([
    [['history', 'list'], 'HistoryList'],
    [['history', 'remove', 'one', 'two'], 'HistoryRemove'],
    [['history', 'clear'], 'HistoryClear'],
    [['history', 'redownload', 'one'], 'HistoryRedownload'],
    [['debug', 'get'], 'DebugGet'],
    [['debug', 'export'], 'DebugExport'],
  ])('parses %s', (arguments_, expectedTag) => {
    expect(parseCliArguments(arguments_).command._tag).toBe(expectedTag);
  });

  it('rejects invalid human item numbers', () => {
    expect(() =>
      parseCliArguments([
        'export',
        'https://www.instagram.com/p/example/',
        '--item',
        '0',
        '--mode',
        'direct',
      ])
    ).toThrow();
  });

  it('requires an explicit silent re-encode policy', () => {
    expect(() =>
      parseCliArguments([
        'export',
        'https://www.instagram.com/p/example/',
        '--item',
        '1',
        '--mode',
        'silent',
      ])
    ).toThrow('Missing --reencode');
  });

  it('parses repeated item operations as a mixed batch', () => {
    const parsed = parseCliArguments([
      'export',
      'https://www.instagram.com/p/example/',
      '--item',
      '1',
      '--mode',
      'direct',
      '--item',
      '3',
      '--mode',
      'frame',
      '--at',
      '8',
    ]);
    expect(parsed.command._tag).toBe('Export');
    if (parsed.command._tag !== 'Export') return;
    expect(parsed.command.operations).toMatchObject([
      { itemNumber: 1, mode: { _tag: 'DirectExport' } },
      { itemNumber: 3, mode: { _tag: 'FrameExport', timestampSeconds: 8 } },
    ]);
  });
});
