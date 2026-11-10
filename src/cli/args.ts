/**
 * Argument-parsing helpers shared by the CLI subcommands, moved verbatim
 * from bin/thatch when the registry replaced the switch. They die loudly
 * (console.error + exit 1) on bad input: a flag given with no value is a
 * typo, not a default.
 */

/** Parses an ISO timestamp or epoch-milliseconds value into epoch ms. */
export function parseTimeBound(value: string, flag: string): number {
  const asNum = Number(value);
  if (Number.isFinite(asNum) && value !== "") return asNum;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    console.error(`error: ${flag} expects an ISO timestamp or epoch ms, got "${value}"`);
    process.exit(1);
  }
  return parsed;
}

/** Reads a flag's value (-flag value or --flag=value forms). A flag given
 *  with no value is a typo, not a default - it dies loudly so `--until`
 *  at the end of a command line cannot silently disable the bound. */
export function flagValue(flags: string[], ...names: string[]): string | undefined {
  for (let i = 0; i < flags.length; i++) {
    for (const name of names) {
      if (flags[i] === name) {
        if (flags[i + 1] === undefined) {
          console.error(`error: ${name} expects a value`);
          process.exit(1);
        }
        return flags[i + 1];
      }
      if (flags[i]?.startsWith(`${name}=`)) return flags[i]!.slice(name.length + 1);
    }
  }
  return undefined;
}

/** Collects every occurrence of a repeatable flag, dying on a dangling one. */
export function flagValues(flags: string[], ...names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < flags.length; i++) {
    for (const name of names) {
      if (flags[i] === name) {
        if (flags[i + 1] === undefined) {
          console.error(`error: ${name} expects a value`);
          process.exit(1);
        }
        out.push(flags[i + 1]);
      } else if (flags[i]?.startsWith(`${name}=`)) out.push(flags[i]!.slice(name.length + 1));
    }
  }
  return out;
}
