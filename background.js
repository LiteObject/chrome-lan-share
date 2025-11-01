const openSidePanel = (tab) => {
    if (!tab || tab.id === undefined) {
        console.warn('No active tab to attach side panel.');
        return;
    }

    if (!chrome.sidePanel) {
        chrome.action.setPopup({ popup: 'popup.html' });
        console.warn('sidePanel API unavailable; switched back to popup.');
        return;
    }

    chrome.sidePanel
        .open({ tabId: tab.id })
        .catch((error) => console.error('Failed to open side panel', error));
};

chrome.runtime.onInstalled.addListener(() => {
    if (!chrome.sidePanel) {
        chrome.action.setPopup({ popup: 'popup.html' });
        return;
    }

    chrome.sidePanel
        .setOptions({ path: 'sidepanel.html' })
        .catch((error) => console.error('Failed to set side panel options', error));
});

chrome.action.onClicked.addListener(openSidePanel);
