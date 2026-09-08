import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerArgs } from '../src/args.ts'

const parse = (argv: string[]) => parseServerArgs(argv, '1.2.3')
afterEach(() => vi.restoreAllMocks())

describe('Web backend arguments', () => {
  it('starts Web without a command or profile selection', () => {
    expect(parse([])).toEqual({ patches: [], args: [], dumpConfig: false, defaultOnly: false })
  })

  it('keeps HTTP options and ordered configuration overlays', () => {
    expect(parse(['--patch', 'a.yml', '--patch', 'b.yml', '--host', '127.0.0.1', '--port', '0', '--no-open']))
      .toEqual({ patches: ['a.yml', 'b.yml'], args: ['--host', '127.0.0.1', '--port', '0', '--no-open'], dumpConfig: false, defaultOnly: false })
    expect(parse(['--help']).args).toEqual(['--help'])
  })

  it('selects boot-free configuration dumps', () => {
    expect(parse(['--dump-config', '--patch', 'a.yml']))
      .toEqual({ patches: ['a.yml'], args: [], dumpConfig: true, defaultOnly: false })
    expect(parse(['--dump-default-config']))
      .toEqual({ patches: [], args: [], dumpConfig: true, defaultOnly: true })
  })

  it.each([
    ['--profile', 'sdk'], ['--profile=headless'], ['--patch', ''],
    ['--dump-config', '--dump-default-config'], ['--dump-config', '--port', '0'],
    ['--dump-default-config', '--patch', 'a.yml'],
  ])('rejects unsupported or contradictory options %j', (...argv) => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('usage rejected') })
    vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    expect(() => parse(argv)).toThrow('usage rejected')
    expect(exit).toHaveBeenCalledWith(1)
  })
})
