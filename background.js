const openSidePanel = (tab) => {
    if (!tab || tab.id === undefined) {
        console.warn('No active tab to attach side panel.');
        return;
    }

    if (!chrome.sidePanel) {
        const url = chrome.runtime.getURL('sidepanel.html');
        chrome.tabs.create({ url }, () => {
            if (chrome.runtime.lastError) {
                console.error('Failed to open side panel fallback tab', chrome.runtime.lastError);
            }
        });
        console.warn('sidePanel API unavailable; opened sidepanel.html in a new tab instead.');
        return;
    }

    chrome.sidePanel
        .open({ tabId: tab.id })
        .catch((error) => console.error('Failed to open side panel', error));
};

chrome.runtime.onInstalled.addListener(() => {
    if (!chrome.sidePanel) {
        console.warn('sidePanel API unavailable during install; users must open sidepanel.html manually.');
        return;
    }

    chrome.sidePanel
        .setOptions({ path: 'sidepanel.html' })
        .catch((error) => console.error('Failed to set side panel options', error));
});

chrome.action.onClicked.addListener(openSidePanel);
