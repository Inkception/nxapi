import type { Arguments as ParentArguments } from '../pctl.js';
import { getPctlToken } from '../../common/auth/moon.js';
import createDebug from '../../util/debug.js';
import { ArgumentsCamelCase, Argv, YargsArguments } from '../../util/yargs.js';
import { initStorage } from '../../util/storage.js';

const debug = createDebug('cli:pctl:user');

export const command = 'user';
export const desc = 'Get the authenticated Nintendo Account';

export function builder(yargs: Argv<ParentArguments>) {
    return yargs.option('user', {
        describe: 'Nintendo Account ID',
        type: 'string',
    }).option('token', {
        describe: 'Nintendo Account session token',
        type: 'string',
    });
}

type Arguments = YargsArguments<ReturnType<typeof builder>>;

export async function handler(argv: ArgumentsCamelCase<Arguments>) {
    const storage = await initStorage(argv.dataPath);

    const usernsid = argv.user ?? await storage.getItem('SelectedUser');
    const token: string = argv.token ||
        await storage.getItem('NintendoAccountToken-pctl.' + usernsid);
    const {moon, data} = await getPctlToken(storage, token);

    console.log('Nintendo Account', data.user);
}
