import process from 'node:process';
import type { Arguments as ParentArguments } from '../../cli.js';
import createDebug from '../../util/debug.js';
import { Argv, YargsArguments } from '../../util/yargs.js';
import * as commands from './commands.js';

const debug = createDebug('cli:nso');

export const command = 'nso <command>';
export const desc = 'Nintendo Switch Online';

export function builder(yargs: Argv<ParentArguments>) {
    for (const command of Object.values(commands)) {
        // @ts-expect-error
        yargs.command(command);
    }

    return yargs.option('znc-proxy-url', {
        describe: 'URL of Nintendo Switch Online app API proxy server to use',
        type: 'string',
        default: process.env.ZNC_PROXY_URL,
    });
}

export type Arguments = YargsArguments<ReturnType<typeof builder>>;
