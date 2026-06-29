import { type SheetsResponse, onSheetsRequest } from '../lib/events';

// Relay Google Sheets requests from the page to the background service worker.
// chrome.identity and the Sheets API only work in the background context, so the
// content script just forwards the message and passes the response back.
onSheetsRequest(async ({ action, data }): Promise<SheetsResponse> => {
	try {
		const response = (await chrome.runtime.sendMessage({
			action,
			data,
		})) as SheetsResponse | undefined;
		return response ?? { ok: false, error: 'No response from background' };
	} catch (error) {
		return { ok: false, error: String(error) };
	}
});

function injectScript(file: string): void {
	const s: HTMLScriptElement = document.createElement('script');
	s.src = chrome.runtime.getURL(file);
	s.onload = () => s.remove();
	(document.head || document.documentElement).append(s);
}

function injectStyle(file: string): void {
	const s: HTMLLinkElement = document.createElement('link');
	s.rel = 'stylesheet';
	s.href = chrome.runtime.getURL(file);
	(document.head || document.documentElement).append(s);
}

injectScript('dist/lib-react.js');
injectScript('dist/react.js');
injectStyle('dist/react.css');
injectScript('dist/showdown.js');
