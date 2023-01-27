import { BrowserWindow, Menu, MenuItem, nativeImage } from './electron.js';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import fetch from 'node-fetch';
import { dir } from '../../util/product.js';
import { App } from './index.js';
import { SavedToken } from '../../common/auth/coral.js';

export const bundlepath = path.resolve(dir, 'dist', 'app', 'bundle');

export async function getNativeImageFromUrl(url: URL | string, useragent?: string) {
    const response = await fetch(url.toString(), {
        headers: {
            'User-Agent': useragent ?? '',
        },
    });
    const image = await response.arrayBuffer();
    return nativeImage.createFromBuffer(Buffer.from(image));
}

export async function tryGetNativeImageFromUrl(url: URL | string, useragent?: string) {
    try {
        return await getNativeImageFromUrl(url, useragent);
    } catch (err) {}

    return undefined;
}

export async function askUserForUri(app: App, uri: string, prompt: string): Promise<[string, SavedToken] | null> {
    const menu = new Menu();

    const ids = await app.store.storage.getItem('NintendoAccountIds') as string[] | undefined;
    menu.append(new MenuItem({label: prompt, enabled: false}));
    menu.append(new MenuItem({label: uri, enabled: false}));
    menu.append(new MenuItem({type: 'separator'}));

    let selected_user: [string, SavedToken] | null = null;

    const items = await Promise.all(ids?.map(async id => {
        const token = await app.store.storage.getItem('NintendoAccountToken.' + id) as string | undefined;
        if (!token) return;
        const data = await app.store.storage.getItem('NsoToken.' + token) as SavedToken | undefined;
        if (!data) return;

        return new MenuItem({
            label: data.nsoAccount.user.name,
            click: (menuItem, browserWindow, event) => {
                selected_user = [token, data];
                menu.closePopup(browserWindow);
            },
        });
    }) ?? []);

    if (!items.length) return null;

    for (const item of items) if (item) menu.append(item);
    menu.append(new MenuItem({type: 'separator'}));
    menu.append(new MenuItem({label: app.i18n.t('handle_uri:cancel')!, click: (i, w) => menu.closePopup(w)}));

    const window = new BrowserWindow({show: false});
    // Add a delay to prevent the menu being closed immediately
    await new Promise(rs => setTimeout(rs, 100));
    await new Promise<void>(rs => menu.popup({callback: rs}));
    window.destroy();

    return selected_user;
}
