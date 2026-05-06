import { Command } from 'commander';
import pc from 'picocolors';

const SYNC_DISABLED_MSG = `
${pc.yellow('Cloud sync is not enabled.')}

Cloud sync is an optional Pro feature that is ${pc.bold('off by default')}.

To enable it:
  1. Sign up at https://memcode.dev/pro
  2. Run ${pc.cyan('memory init')} in your project
  3. Set ${pc.cyan('"cloudSync": { "enabled": true, "provider": "memcode" }')} in ${pc.cyan('.memory/config.json')}
  4. Authenticate with ${pc.cyan('memory sync auth')}

Your local memory is always fully functional without cloud sync.
`;

export const syncCommand = new Command('sync').description(
  'Sync project memory with the cloud (Pro feature)',
);

syncCommand
  .command('push')
  .description('Push summaries and metadata to the cloud')
  .action(() => {
    // Feature flag — cloud sync is disabled in v1 OSS build
    if (!process.env.MEMCODE_CLOUD_ENABLED) {
      console.log(SYNC_DISABLED_MSG);
      return;
    }

    // When cloud sync is implemented, delegate to @memcode/cloud-client here
    console.log(pc.yellow('Cloud sync not yet configured.'));
  });

syncCommand
  .command('pull')
  .description('Pull latest summaries from the cloud and merge')
  .action(() => {
    if (!process.env.MEMCODE_CLOUD_ENABLED) {
      console.log(SYNC_DISABLED_MSG);
      return;
    }

    console.log(pc.yellow('Cloud sync not yet configured.'));
  });

syncCommand
  .command('status')
  .description('Show cloud sync status')
  .action(() => {
    if (!process.env.MEMCODE_CLOUD_ENABLED) {
      console.log(SYNC_DISABLED_MSG);
      return;
    }

    console.log(pc.yellow('Cloud sync not yet configured.'));
  });
