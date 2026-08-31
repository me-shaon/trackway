#!/usr/bin/env node
import { Command } from 'commander';
import {
  consoleIo,
  decisionsCommand,
  evalCommandEntry,
  forgetCommand,
  graphCommandEntry,
  initCommand,
  mcpCommand,
  rebuildCommand,
  ingestCommand,
  rejectedCommand,
  whyCommand,
  searchCommand,
  sessionsCommand,
  showCommand,
  statusCommand,
  syncCommand,
} from './commands/index.js';

/**
 * Every command exits zero unless the user asked for something that does not
 * exist. A non-zero exit from a hook-triggered sweep would surface as an error
 * inside the developer's coding session, which is the one thing this must not
 * do.
 */
async function main(): Promise<void> {
  const program = new Command();

  program
    .name('trackway')
    .description('Answers why a line of code exists, using the agent session behind it.')
    .version('0.4.1')
    .showHelpAfterError();

  program
    .command('init')
    .description('set up Trackway in this repository')
    .option('--no-hook', 'skip installing the agent hook')
    .action(async (options) => process.exit(await initCommand(options, consoleIo)));

  program
    .command('sync')
    .description('distil sessions that have gone quiet')
    .option('-q, --quiet', 'print nothing on success')
    .option('--max <n>', 'stop after this many sessions', Number)
    .option('--if-due', 'skip unless the configured interval has passed (used by the hook)')
    .option('--max-calls <n>', 'stop after this many model calls, resuming next run', Number)
    .action(async (options) => process.exit(await syncCommand(options, consoleIo)));

  program
    .command('status')
    .description('what is stored, which agents are found, what is pending')
    .action(async (options) => process.exit(await statusCommand(options, consoleIo)));

  program
    .command('search <query>')
    .description('search everything recorded')
    .option('-t, --type <type>', 'question, discovery, decision, action or outcome')
    .option('-n, --limit <n>', 'maximum results', Number)
    .option('--json', 'machine-readable output')
    .option('--no-sync', 'do not catch up before searching')
    .action(async (query, options) => process.exit(await searchCommand(query, options, consoleIo)));

  program
    .command('ingest [file]')
    .description('read a transcript from any agent, from a file or stdin')
    .option('--json', 'machine-readable output')
    .action(async (file, options) => process.exit(await ingestCommand(file, options, consoleIo)));

  program
    .command('why <file> [line]')
    .description('what was decided that produced this line, and what was rejected')
    .option('-n, --limit <n>', 'maximum records', Number)
    .option('--all', 'include the agent\'s working notes')
    .option('--json', 'machine-readable output')
    .action(async (file, line, options) =>
      process.exit(await whyCommand(file, line, options, consoleIo)),
    );

  program
    .command('rejected [query]')
    .description('options that were considered and not taken')
    .option('-n, --limit <n>', 'maximum results', Number)
    .option('--json', 'machine-readable output')
    .action(async (query, options) =>
      process.exit(await rejectedCommand(query, options, consoleIo)),
    );

  program
    .command('decisions')
    .description('decisions, newest first')
    .option('-a, --actor <who>', 'human or agent')
    .option('--implicit', 'only decisions the agent made without explicit approval')
    .option('-n, --limit <n>', 'maximum results', Number)
    .option('--json', 'machine-readable output')
    .action(async (options) => process.exit(await decisionsCommand(options, consoleIo)));

  program
    .command('show <id>')
    .description('one record in full')
    .option('--json', 'machine-readable output')
    .action(async (id, options) => process.exit(await showCommand(id, options, consoleIo)));

  program
    .command('sessions')
    .description('sessions that produced records')
    .option('--json', 'machine-readable output')
    .action(async (options) => process.exit(await sessionsCommand(options, consoleIo)));

  program
    .command('forget <target>')
    .description('remove a record, or every record from a session')
    .option('-s, --session', 'treat the target as a session id')
    .action(async (target, options) => process.exit(await forgetCommand(target, options, consoleIo)));

  program
    .command('graph')
    .description('open the local explorer: story, decisions, overview')
    .option('-p, --port <n>', 'port to listen on', Number)
    .option('--no-open', 'do not launch a browser')
    .action(async (options) => process.exit(await graphCommandEntry(options, consoleIo)));

  program
    .command('mcp')
    .description('serve memory to a coding agent over stdio (read-only)')
    .action(async (options) => {
      await mcpCommand(options, consoleIo);
    });

  program
    .command('eval')
    .description('measure extraction quality against sessions that carry their own answer key')
    .option('-n, --limit <n>', 'how many sessions to score', Number)
    .option('--key-only', 'skip judging, report only agreement with the answer key')
    .option('--json', 'machine-readable output')
    .action(async (options) => process.exit(await evalCommandEntry(options, consoleIo)));

  program
    .command('rebuild')
    .description('rebuild the search index from the record files')
    .action(async (options) => process.exit(await rebuildCommand(options, consoleIo)));

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  process.stderr.write(`trackway: ${String(error instanceof Error ? error.message : error)}\n`);
  process.exit(1);
});
