// sidepanel.js
// Simple manual-signaling WebRTC DataChannel for text & file transfer (chunked).
// Works inside the side panel UI (DOM available).

const createOfferBtn = document.getElementById('createOffer');
const createAnswerBtn = document.getElementById('createAnswer');
const setRemoteBtn = document.getElementById('setRemote');
const disconnectBtn = document.getElementById('disconnect');
const localSDPTextarea = document.getElementById('localSDP');
const remoteSDPTextarea = document.getElementById('remoteSDP');
const copyLocalBtn = document.getElementById('copyLocal');
const copyAnswerBtn = document.getElementById('copyAnswer');
const iceStatus = document.getElementById('iceStatus');
const connStatus = document.getElementById('connStatus');

const messagesDiv = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendMsgBtn = document.getElementById('sendMsg');

const fileInput = document.getElementById('fileInput');
const fileProgress = document.getElementById('fileProgress');
const fileProgressText = document.getElementById('fileProgressText');
const fileProgressPercent = document.getElementById('fileProgressPercent');
const cancelTransferBtn = document.getElementById('cancelTransfer');

const useServerCheckbox = document.getElementById('useServer');
const connectServerBtn = document.getElementById('connectServer');
const serverIPInput = document.getElementById('serverIP');
const darkModeToggle = document.getElementById('darkModeToggle');

const setupTab = document.getElementById('setupTab');
const chatTab = document.getElementById('chatTab');
const setupContent = document.getElementById('setupContent');
const chatContent = document.getElementById('chatContent');

const CHUNK_SIZE = 16 * 1024; // send files in 16KB chunks to balance speed and reliability
const BUFFERED_AMOUNT_LIMIT = 1024 * 1024; // pause if DataChannel buffers exceed 1MB
const BUFFERED_AMOUNT_LOW_THRESHOLD = Math.floor(BUFFERED_AMOUNT_LIMIT / 2);
const ICE_GATHER_TIMEOUT_MS = 15000; // allow slower networks more time to surface ICE candidates
const SEND_WINDOW_TIMEOUT_MS = 5000;
const SEND_WINDOW_CHECK_INTERVAL_MS = 50;
const NEXT_TICK_DELAY_MS = 0;
const PROGRESS_UPDATE_THROTTLE_MS = 16;
const MAX_FILE_METADATA_PER_MINUTE = 10;
const FILE_METADATA_WINDOW_MS = 60_000;

let pc = null;
let dc = null;
let isOfferer = false;
let ws = null;
let useServer = false;
let waitingForServerOffer = false;
let activeSend = null;
let cancelCurrentTransfer = null;
let fileMetaCounter = 0;
let fileMetaResetTimeout = null;
let lastProgressUpdate = 0;

function normalizeServerAddress(raw) {
    if (!raw) return null;
    let input = raw.trim();
    if (!input) return null;

    if (/^wss?:\/\//i.test(input)) {
        // already a ws(s) URL
    } else if (/^https?:\/\//i.test(input)) {
        input = input.replace(/^http/i, 'ws');
    } else if (/^\/\//.test(input)) {
        input = `ws:${input}`;
    } else {
        input = `ws://${input}`;
    }

    try {
        const url = new URL(input);
        if (!url.hostname) {
            return null;
        }
        if (url.port) {
            const portNum = Number(url.port);
            if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
                return null;
            }
        }
        if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
            return null;
        }
        return url.toString();
    } catch (err) {
        console.error('Invalid WebSocket address', err);
        return null;
    }
}

function setCancelAction(handler, label = 'Cancel Transfer') {
    if (!cancelTransferBtn) {
        cancelCurrentTransfer = null;
        return;
    }
    cancelCurrentTransfer = handler || null;
    if (cancelCurrentTransfer) {
        cancelTransferBtn.disabled = false;
        cancelTransferBtn.hidden = false;
        cancelTransferBtn.textContent = label;
    } else {
        cancelTransferBtn.disabled = true;
        cancelTransferBtn.hidden = true;
        cancelTransferBtn.textContent = 'Cancel Transfer';
    }
}

function clearFileProgress(message = '') {
    fileProgress.value = 0;
    fileProgress.max = 100;
    fileProgressText.textContent = message;
    if (fileProgressPercent) {
        fileProgressPercent.textContent = '0%';
    }
    lastProgressUpdate = 0;
}

function showError(message, { alertUser = false, level = 'error', prefixLog = true } = {}) {
    const fn = console[level] ? console[level].bind(console) : console.error.bind(console);
    fn(message);
    if (prefixLog) {
        logMessage(`Error: ${message}`, 'peer');
    }
    if (alertUser) {
        alert(message);
    }
}

if (cancelTransferBtn) {
    cancelTransferBtn.addEventListener('click', () => {
        if (cancelCurrentTransfer) {
            try {
                cancelCurrentTransfer();
            } catch (err) {
                console.error('Failed to cancel transfer', err);
            }
        }
    });
} else {
    console.warn('Cancel transfer button not found in DOM');
}

function ensureChannelOpen() {
    if (!dc || dc.readyState !== 'open') {
        throw new Error('DataChannel is not open');
    }
}

function assertSendState(state) {
    if (state && (state.cancelRequested || state.peerCancelled)) {
        const reason = state.cancelReason || (state.peerCancelled ? 'peer cancelled' : 'sender cancelled');
        throw new Error(reason);
    }
}

function waitForNextMicrotask() {
    return new Promise((resolve) => setTimeout(resolve, NEXT_TICK_DELAY_MS));
}

async function waitForSendWindow(state, channel = dc) {
    if (!channel || channel.readyState !== 'open' || channel.bufferedAmount <= BUFFERED_AMOUNT_LIMIT) {
        assertSendState(state);
        return;
    }

    await new Promise((resolve, reject) => {
        let settled = false;

        const settle = (fn) => (value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        const onResolve = settle(resolve);
        const onReject = settle(reject);

        const onLow = () => {
            try {
                assertSendState(state);
                if (!channel || channel.readyState !== 'open') {
                    throw new Error('DataChannel is not open');
                }
                onResolve();
            } catch (err) {
                onReject(err);
            }
        };

        const onClose = () => {
            onReject(new Error('DataChannel is not open'));
        };

        const checkInterval = setInterval(() => {
            try {
                assertSendState(state);
                if (!channel || channel.readyState !== 'open') {
                    throw new Error('DataChannel is not open');
                }
            } catch (err) {
                onReject(err);
                return;
            }
            if (channel.bufferedAmount <= BUFFERED_AMOUNT_LIMIT) {
                onResolve();
            }
        }, SEND_WINDOW_CHECK_INTERVAL_MS);

        const timeout = setTimeout(() => {
            try {
                assertSendState(state);
                if (!channel || channel.readyState !== 'open') {
                    throw new Error('DataChannel is not open');
                }
                onResolve();
            } catch (err) {
                onReject(err);
            }
        }, SEND_WINDOW_TIMEOUT_MS);

        const cleanup = () => {
            clearInterval(checkInterval);
            clearTimeout(timeout);
            try {
                channel?.removeEventListener('bufferedamountlow', onLow);
                channel?.removeEventListener('close', onClose);
            } catch (err) {
                console.warn('Failed to cleanup bufferedamount listeners', err);
            }
        };

        try {
            channel.addEventListener('bufferedamountlow', onLow, { once: true });
            channel.addEventListener('close', onClose, { once: true });
        } catch (err) {
            console.error('Failed to attach bufferedamount listeners', err);
        }
    });
}

function cleanupConnections({ closeWebSocket = false } = {}) {
    if (dc) {
        try {
            dc.onopen = null;
            dc.onclose = null;
            dc.onerror = null;
            dc.onmessage = null;
            dc.onbufferedamountlow = null;
            dc.close();
        } catch (err) {
            console.warn('Failed to close DataChannel', err);
        }
        dc = null;
    }

    if (pc) {
        try {
            pc.onicecandidate = null;
            pc.oniceconnectionstatechange = null;
            pc.onicegatheringstatechange = null;
            pc.onconnectionstatechange = null;
            pc.ondatachannel = null;
            pc.close();
        } catch (err) {
            console.warn('Failed to close RTCPeerConnection', err);
        }
        pc = null;
    }

    if (closeWebSocket && ws) {
        try {
            ws.onopen = null;
            ws.onmessage = null;
            ws.onerror = null;
            ws.onclose = null;
            ws.close();
        } catch (err) {
            console.warn('Failed to close signaling WebSocket', err);
        }
        ws = null;
    }
}

async function sendChunk(chunk, sendState = activeSend) {
    const state = sendState || activeSend;
    assertSendState(state);
    ensureChannelOpen();
    const channel = dc;
    if (!channel || channel.readyState !== 'open') {
        throw new Error('DataChannel is not open');
    }
    await waitForSendWindow(state, channel);
    assertSendState(state);
    if (!channel || channel.readyState !== 'open') {
        throw new Error('DataChannel is not open');
    }
    const payload = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    assertSendState(state);
    channel.send(payload);
    if (channel.bufferedAmount > BUFFERED_AMOUNT_LIMIT) {
        await waitForSendWindow(state, channel);
    } else {
        await waitForNextMicrotask();
    }
}

function updateSendProgress(file, sent) {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (sent < file.size && now - lastProgressUpdate < PROGRESS_UPDATE_THROTTLE_MS) {
        return;
    }
    lastProgressUpdate = now;
    const percent = file.size ? (sent / file.size) * 100 : 0;
    fileProgress.value = percent;
    const prettyPercent = percent ? percent.toFixed(1) : '0.0';
    fileProgressText.textContent = `Sending "${file.name}" (${sent} / ${file.size}) – ${prettyPercent}%`;
    if (fileProgressPercent) {
        fileProgressPercent.textContent = `${prettyPercent}%`;
    }
}

function sendFileSignal(payload) {
    if (!dc || dc.readyState !== 'open') return false;
    try {
        dc.send(JSON.stringify(payload));
        return true;
    } catch (err) {
        console.error('Failed to send file control message', err);
        return false;
    }
}

function notifyPeerFileError(id, name, reason) {
    sendFileSignal({ type: 'file-error', id, name, reason });
}

function handleFileSendFailure(id, name, reason, state = activeSend) {
    const sendState = state || activeSend;
    const friendlyReason = reason === 'DataChannel is not open' ? 'channel closed' : reason;
    const suppressNotify = friendlyReason && ['sender cancelled', 'receiver cancelled', 'peer cancelled', 'missing metadata before file data', 'peer error'].includes(friendlyReason);
    if (!suppressNotify) {
        notifyPeerFileError(id, name, friendlyReason);
    }
    let statusText = `Send failed for "${name}"${friendlyReason ? `: ${friendlyReason}` : ''}`;
    if (friendlyReason === 'sender cancelled') {
        statusText = `Send cancelled for "${name}"`;
        logMessage(`File send cancelled: ${name}`, 'peer');
    } else if (friendlyReason === 'receiver cancelled' || friendlyReason === 'peer cancelled') {
        statusText = `Send cancelled by peer${name ? `: "${name}"` : ''}`;
        logMessage(`Peer cancelled file transfer${name ? `: ${name}` : ''}`, 'peer');
    } else {
        logMessage(`File send failed: ${name}${friendlyReason ? ` (${friendlyReason})` : ''}`, 'peer');
    }
    clearFileProgress(statusText);
    if (sendState) {
        sendState.cancelRequested = true;
        sendState.cancelReason = friendlyReason;
    }
    activeSend = null;
    setCancelAction(null);
}

async function sendFileFromStream(file) {
    const sendState = activeSend;
    const reader = file.stream().getReader();
    if (sendState) {
        sendState.reader = reader;
    }
    let sent = 0;
    try {
        while (true) {
            if (sendState && (sendState.cancelRequested || sendState.peerCancelled)) {
                const reason = sendState.cancelReason || (sendState.peerCancelled ? 'peer cancelled' : 'sender cancelled');
                throw new Error(reason);
            }
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            const chunkView = value instanceof Uint8Array ? value : new Uint8Array(value);
            let offset = 0;
            while (offset < chunkView.byteLength) {
                const end = Math.min(offset + CHUNK_SIZE, chunkView.byteLength);
                const slice = chunkView.subarray(offset, end);
                const safeCopy = slice.slice();
                await sendChunk(safeCopy, sendState);
                sent += slice.byteLength;
                updateSendProgress(file, sent);
                offset = end;
            }
        }
    } finally {
        reader.releaseLock?.();
        if (sendState && sendState.reader === reader) {
            sendState.reader = null;
        }
    }
}

async function sendFileFromArrayBuffer(file) {
    const sendState = activeSend;
    const reader = new FileReader();
    let sent = 0;
    const readerWrapper = {
        cancel: () => {
            try {
                reader.abort();
            } catch (abortErr) {
                console.warn('Failed to abort FileReader', abortErr);
            }
        }
    };
    if (sendState) {
        sendState.reader = readerWrapper;
    }

    try {
        for (let offset = 0; offset < file.size;) {
            assertSendState(sendState);
            const end = Math.min(offset + CHUNK_SIZE, file.size);
            const chunkBuffer = await readFileSlice(reader, file.slice(offset, end), sendState);
            assertSendState(sendState);
            await sendChunk(new Uint8Array(chunkBuffer), sendState);
            sent += chunkBuffer.byteLength;
            updateSendProgress(file, sent);
            offset = end;
        }
    } finally {
        if (sendState && sendState.reader === readerWrapper) {
            sendState.reader = null;
        }
    }
}

function readFileSlice(reader, blob, state) {
    return new Promise((resolve, reject) => {
        const cleanup = () => {
            reader.onload = null;
            reader.onerror = null;
            reader.onabort = null;
        };

        reader.onload = () => {
            cleanup();
            resolve(reader.result);
        };

        const fail = (err) => {
            cleanup();
            if (err?.name === 'AbortError') {
                const reason = state?.cancelReason || (state?.peerCancelled ? 'peer cancelled' : 'sender cancelled');
                reject(new Error(reason || 'sender cancelled'));
            } else {
                reject(err || new Error('Failed to read file chunk'));
            }
        };

        reader.onerror = () => fail(reader.error);
        reader.onabort = () => fail(reader.error || new DOMException('Aborted', 'AbortError'));

        try {
            reader.readAsArrayBuffer(blob);
        } catch (err) {
            fail(err);
        }
    });
}

function resetUI() {
    updateIceStatus();
    updateConnStatus();
    copyLocalBtn.disabled = true;
    setRemoteBtn.disabled = true;
    if (copyAnswerBtn) {
        copyAnswerBtn.hidden = true;
        copyAnswerBtn.disabled = true;
        copyAnswerBtn.textContent = 'Copy Local Answer';
    }
    localSDPTextarea.value = '';
    remoteSDPTextarea.value = '';
    clearFileProgress();
    waitingForServerOffer = false;
    setCancelAction(null);
    updateSignalingUI();
}

resetUI();

darkModeToggle.addEventListener('click', () => {
    document.body.classList.toggle('dark');
    darkModeToggle.textContent = document.body.classList.contains('dark') ? '☀️ Light Mode' : '🌙 Dark Mode';
});

setupTab.addEventListener('click', () => {
    setupTab.classList.add('active');
    chatTab.classList.remove('active');
    setupContent.classList.add('active');
    chatContent.classList.remove('active');
});

chatTab.addEventListener('click', () => {
    chatTab.classList.add('active');
    setupTab.classList.remove('active');
    chatContent.classList.add('active');
    setupContent.classList.remove('active');
});

document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented) return;
    const activeTag = document.activeElement?.tagName;
    const isTyping = activeTag === 'INPUT' || activeTag === 'TEXTAREA';

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'd') {
        event.preventDefault();
        disconnectBtn.click();
        return;
    }

    if (!isTyping && event.key === 'Escape' && !cancelTransferBtn.hidden && !cancelTransferBtn.disabled) {
        event.preventDefault();
        cancelTransferBtn.click();
    }
});

useServerCheckbox.addEventListener('change', () => {
    useServer = useServerCheckbox.checked;
    waitingForServerOffer = false;
    if (!useServer && ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
            ws.close();
        } catch (err) {
            console.warn('Failed to close signaling WebSocket on toggle', err);
        }
        ws = null;
    }
    updateSignalingUI();
});

disconnectBtn.addEventListener('click', () => {
    if (activeSend) {
        handleFileSendFailure(activeSend.id, activeSend.name, 'connection reset', activeSend);
    }
    cleanupConnections({ closeWebSocket: false });
    isOfferer = false;
    waitingForServerOffer = false;
    resetUI();
    logMessage('Connection reset by user', 'peer');
});

connectServerBtn.addEventListener('click', () => {
    if (!useServer) {
        showError('Enable "Use Signaling Server" before connecting.', { alertUser: true, prefixLog: false });
        return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        try {
            ws.close();
        } catch (err) {
            console.warn('Failed to close existing signaling WebSocket', err);
        }
        ws = null;
        updateSignalingUI();
        return;
    }

    const normalized = normalizeServerAddress(serverIPInput.value);
    if (!normalized) {
        showError('Please enter a valid WebSocket address (e.g., ws://localhost:8080).', { alertUser: true, prefixLog: false });
        return;
    }

    let socket;
    try {
        socket = new WebSocket(normalized);
    } catch (err) {
        console.error('Failed to initiate WebSocket', err);
        showError('Invalid WebSocket URL. Please verify the address and try again.', { alertUser: true });
        return;
    }

    ws = socket;
    updateSignalingUI();

    socket.addEventListener('open', () => {
        if (ws !== socket) return;
        logMessage(`Connected to signaling server at ${normalized}`, 'peer');
        updateSignalingUI();
    });

    socket.addEventListener('message', async (event) => {
        if (ws !== socket) return;
        let payload = event.data;
        if (payload instanceof Blob) {
            payload = await payload.text();
        } else if (payload instanceof ArrayBuffer) {
            payload = new TextDecoder().decode(payload);
        }

        let data;
        try {
            data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        } catch (err) {
            console.error('Invalid signaling payload', err);
            logMessage('Received malformed message from signaling server (ignored).', 'peer');
            return;
        }

        if (!data || typeof data.type !== 'string') {
            logMessage('Received unknown signaling payload format.', 'peer');
            return;
        }

        if (data.type === 'offer' && data.sdp) {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            if (!isOfferer) {
                try {
                    await respondToOffer(data.sdp, 'server');
                } catch (err) {
                    console.error('Failed to handle offer from server', err);
                }
            }
        } else if (data.type === 'answer' && data.sdp) {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            if (isOfferer) {
                try {
                    await applyRemoteAnswer(data.sdp, 'server');
                } catch (err) {
                    console.error('Failed to apply answer from server', err);
                }
            }
        } else {
            logMessage(`Unhandled signaling message type: ${data.type}`, 'peer');
        }
    });

    socket.addEventListener('close', () => {
        if (ws === socket) {
            ws = null;
            waitingForServerOffer = false;
            updateSignalingUI();
        }
        logMessage('Disconnected from signaling server', 'peer');
    });

    socket.addEventListener('error', (error) => {
        console.error('Signaling server error', error);
        if (ws === socket) {
            logMessage('Failed to connect to signaling server.', 'peer');
        }
    });
});

function logMessage(text, who = 'peer') {
    const el = document.createElement('div');
    el.className = `message ${who === 'me' ? 'me' : 'peer'}`;
    const timestamp = new Date().toLocaleTimeString();
    el.textContent = `[${timestamp}] ${text}`;
    messagesDiv.appendChild(el);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function waitForIceGatheringComplete(peer, timeoutMs = ICE_GATHER_TIMEOUT_MS) {
    if (!peer) {
        return Promise.resolve({ complete: false, reason: 'no-peer' });
    }

    if (peer.iceGatheringState === 'complete') {
        return Promise.resolve({ complete: true, reason: 'already-complete' });
    }

    return new Promise((resolve) => {
        let settled = false;

        const finish = (complete, reason) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({ complete, reason });
        };

        const onIceGatheringChange = () => {
            updateIceStatus();
            if (peer.iceGatheringState === 'complete') {
                finish(true, 'gathering-complete');
            }
        };

        const onIceCandidate = (event) => {
            if (!event.candidate) {
                finish(true, 'end-of-candidates');
            }
        };

        const cleanup = () => {
            try { peer.removeEventListener('icegatheringstatechange', onIceGatheringChange); } catch (err) { /* noop */ }
            try { peer.removeEventListener('icecandidate', onIceCandidate); } catch (err) { /* noop */ }
            if (timer) {
                clearTimeout(timer);
            }
        };

        const timer = timeoutMs > 0
            ? setTimeout(() => {
                if (peer.iceGatheringState === 'complete') {
                    finish(true, 'gathering-complete');
                    return;
                }
                finish(false, 'timeout');
            }, timeoutMs)
            : null;

        try {
            peer.addEventListener('icegatheringstatechange', onIceGatheringChange);
        } catch (err) {
            console.warn('Failed to watch icegatheringstatechange', err);
        }
        try {
            peer.addEventListener('icecandidate', onIceCandidate);
        } catch (err) {
            console.warn('Failed to watch icecandidate events', err);
        }
    });
}

function updateConnStatus() {
    const pcState = pc ? pc.connectionState || '—' : '—';
    const dcState = dc ? dc.readyState : '—';
    const statusClass = (() => {
        if (dcState === 'open') return 'status-connected';
        if (pcState === 'connecting' || dcState === 'connecting') return 'status-connecting';
        if (pcState === 'failed' || pcState === 'disconnected') return 'status-error';
        return 'status-disconnected';
    })();

    connStatus.classList.remove('status-connected', 'status-connecting', 'status-error', 'status-disconnected');
    connStatus.classList.add(statusClass);

    const statusBadge = (() => {
        switch (statusClass) {
            case 'status-connected':
                return '[OK]';
            case 'status-connecting':
                return '[...]';
            case 'status-error':
                return '[ERR]';
            default:
                return '[--]';
        }
    })();

    connStatus.textContent = `${statusBadge} Conn: ${pcState} | DC: ${dcState}`;
}

function updateIceStatus(extra = '') {
    if (!pc) {
        iceStatus.textContent = 'ICE: —';
        return;
    }
    const suffix = extra ? ` ${extra}` : '';
    iceStatus.textContent = `ICE: ${pc.iceGatheringState}${suffix}`;
}

function updateSignalingUI() {
    const serverReady = useServer && ws && ws.readyState === WebSocket.OPEN;
    const serverConnecting = useServer && ws && ws.readyState === WebSocket.CONNECTING;

    if (useServer) {
        localSDPTextarea.style.display = 'none';
        remoteSDPTextarea.style.display = 'none';
        copyLocalBtn.style.display = 'none';
        setRemoteBtn.style.display = 'none';
        createAnswerBtn.textContent = 'Wait for Offer';
        createOfferBtn.disabled = !serverReady;
        createAnswerBtn.disabled = !serverReady;
        connectServerBtn.disabled = false;
        connectServerBtn.textContent = serverReady ? 'Disconnect' : (serverConnecting ? 'Connecting…' : 'Connect to Server');
    } else {
        localSDPTextarea.style.display = 'block';
        remoteSDPTextarea.style.display = 'block';
        copyLocalBtn.style.display = 'inline-block';
        setRemoteBtn.style.display = 'inline-block';
        createAnswerBtn.textContent = 'Set Remote / Create Answer';
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        connectServerBtn.disabled = true;
        connectServerBtn.textContent = 'Connect to Server';
    }
}

function validateSDP(desc) {
    if (!desc || typeof desc !== 'object') {
        throw new Error('SDP must be an object.');
    }
    if (typeof desc.type !== 'string' || !['offer', 'answer', 'pranswer', 'rollback'].includes(desc.type)) {
        throw new Error(`Invalid SDP type: ${desc.type}`);
    }
    if (typeof desc.sdp !== 'string' || !desc.sdp.trim()) {
        throw new Error('SDP is missing the session description string.');
    }
    if (!desc.sdp.includes('v=0') || !desc.sdp.match(/\nm=.*\n?/)) {
        throw new Error('SDP appears malformed.');
    }
}

// Setup a new RTCPeerConnection and optionally create DataChannel
function setupPeerConnection({ createDataChannel = false } = {}) {
    cleanupConnections({ closeWebSocket: false });
    try {
        pc = new RTCPeerConnection({
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' }
            ]
        });
    } catch (err) {
        showError('WebRTC failed to initialize. Ensure your browser supports RTCPeerConnection.', { alertUser: true });
        console.error('RTCPeerConnection creation failed', err);
        pc = null;
        return null;
    }

    const handleIceConnection = () => {
        updateConnStatus();
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            logMessage('ICE connection lost', 'peer');
        }
    };

    pc.addEventListener('connectionstatechange', () => {
        updateConnStatus();
    });

    pc.addEventListener('iceconnectionstatechange', handleIceConnection);

    pc.addEventListener('icecandidate', () => {
        updateIceStatus();
    });

    pc.addEventListener('icegatheringstatechange', () => {
        updateIceStatus();
    });

    if (createDataChannel) {
        dc = pc.createDataChannel('chat', { ordered: true });
        setupDataChannel(dc);
    } else {
        // We'll accept a remote datachannel
        pc.addEventListener('datachannel', (e) => {
            dc = e.channel;
            setupDataChannel(dc);
        });
    }

    updateConnStatus();
    updateIceStatus();

    return pc;
}

function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.bufferedAmountLowThreshold = BUFFERED_AMOUNT_LOW_THRESHOLD;

    let incomingFile = null; // {id, name, size, received, buffers: []}
    let missingMetadataNotified = false;
    let ignoreOrphanBinary = false;

    const clearReceiveState = (message, { allowOrphanChunks = false, updateProgress = true } = {}) => {
        incomingFile = null;
        missingMetadataNotified = false;
        ignoreOrphanBinary = allowOrphanChunks;
        if (updateProgress && typeof message === 'string') {
            clearFileProgress(message);
        } else if (updateProgress && typeof message !== 'string') {
            clearFileProgress('');
        }
        setCancelAction(null);
    };

    channel.addEventListener('open', () => {
        logMessage('DataChannel open', 'peer');
        updateConnStatus();
    });

    channel.addEventListener('close', () => {
        logMessage('DataChannel closed', 'peer');
        updateConnStatus();
        if (activeSend) {
            handleFileSendFailure(activeSend.id, activeSend.name, 'channel closed', activeSend);
        }
        cleanupConnections({ closeWebSocket: false });
        resetUI();
        clearReceiveState('Transfer cancelled.', { allowOrphanChunks: true });
    });

    channel.addEventListener('message', async (evt) => {
        if (typeof evt.data === 'string') {
            try {
                const obj = JSON.parse(evt.data);
                if (obj && obj.type === 'file-meta') {
                    fileMetaCounter += 1;
                    if (fileMetaCounter > MAX_FILE_METADATA_PER_MINUTE) {
                        logMessage('Peer is sending file requests too quickly. Ignoring this request.', 'peer');
                        notifyPeerFileError(obj.id ?? null, obj.name ?? null, 'rate limited');
                        return;
                    }
                    clearTimeout(fileMetaResetTimeout);
                    fileMetaResetTimeout = setTimeout(() => {
                        fileMetaCounter = 0;
                    }, FILE_METADATA_WINDOW_MS);

                    incomingFile = {
                        id: obj.id,
                        name: obj.name,
                        size: obj.size,
                        received: 0,
                        buffers: []
                    };
                    missingMetadataNotified = false;
                    ignoreOrphanBinary = false;
                    fileProgress.value = 0;
                    fileProgress.max = 100;
                    fileProgressText.textContent = `Receiving "${incomingFile.name}" (${incomingFile.received} / ${incomingFile.size}) – 0.0%`;
                    if (fileProgressPercent) {
                        fileProgressPercent.textContent = '0.0%';
                    }
                    lastProgressUpdate = 0;
                    setCancelAction(() => {
                        if (!incomingFile) return;
                        const name = incomingFile.name;
                        sendFileSignal({ type: 'file-cancel', id: incomingFile.id, name, reason: 'receiver cancelled' });
                        clearReceiveState(`Receive cancelled for "${name}"`, { allowOrphanChunks: true });
                        logMessage(`File receive cancelled: ${name}`, 'peer');
                    }, 'Cancel Receive');
                    return;
                }
                if (obj && obj.type === 'file-error') {
                    if (incomingFile) {
                        clearReceiveState(`Peer could not send "${obj.name || 'file'}"${obj.reason ? `: ${obj.reason}` : ''}`, { allowOrphanChunks: true });
                        logMessage(`Peer file transfer failed${obj.name ? `: ${obj.name}` : ''}${obj.reason ? ` (${obj.reason})` : ''}`, 'peer');
                    }
                    if (activeSend && (!obj.id || activeSend.id === obj.id)) {
                        const peerReason = obj.reason || 'peer error';
                        activeSend.cancelRequested = true;
                        activeSend.peerCancelled = true;
                        activeSend.cancelReason = peerReason;
                        if (activeSend.reader && activeSend.reader.cancel) {
                            try { activeSend.reader.cancel(peerReason); } catch (cancelErr) {
                                console.warn('Failed to cancel reader after peer error', cancelErr);
                            }
                        }
                        handleFileSendFailure(activeSend.id, activeSend.name, peerReason, activeSend);
                    }
                    return;
                }
                if (obj && obj.type === 'file-cancel') {
                    const reason = obj.reason || 'peer cancelled';
                    if (incomingFile) {
                        clearReceiveState(`Peer cancelled receive of "${incomingFile.name}"`, { allowOrphanChunks: true });
                    } else {
                        clearReceiveState(`Peer cancelled transfer${obj.name ? `: ${obj.name}` : ''}`, { allowOrphanChunks: true });
                    }
                    if (activeSend && (!obj.id || activeSend.id === obj.id)) {
                        activeSend.cancelRequested = true;
                        activeSend.peerCancelled = true;
                        activeSend.cancelReason = reason;
                        if (activeSend.reader && activeSend.reader.cancel) {
                            try { activeSend.reader.cancel(reason); } catch (cancelErr) {
                                console.warn('Failed to cancel reader after peer cancellation', cancelErr);
                            }
                        }
                        handleFileSendFailure(activeSend.id, activeSend.name, 'receiver cancelled', activeSend);
                    } else {
                        logMessage('Peer cancelled file transfer', 'peer');
                    }
                    return;
                }
            } catch (e) {
                // Not JSON -> treat as plain chat text
            }

            logMessage(evt.data, 'peer');
            return;
        }

        let binaryChunk = null;
        if (evt.data instanceof ArrayBuffer) {
            binaryChunk = evt.data;
        } else if (evt.data instanceof Blob) {
            try {
                binaryChunk = await evt.data.arrayBuffer();
            } catch (blobErr) {
                console.error('Failed to read Blob chunk', blobErr);
                notifyPeerFileError(incomingFile?.id ?? null, incomingFile?.name ?? null, 'failed to read blob chunk');
                clearReceiveState('Failed to read incoming file chunk.', { allowOrphanChunks: true });
                return;
            }
        }

        if (binaryChunk instanceof ArrayBuffer) {
            if (!incomingFile) {
                if (ignoreOrphanBinary) {
                    return;
                }
                if (!missingMetadataNotified) {
                    missingMetadataNotified = true;
                    clearReceiveState(null, { allowOrphanChunks: true, updateProgress: false });
                    notifyPeerFileError(null, null, 'missing metadata before file data');
                    logMessage('File receive failed (missing metadata). Requested peer to resend.', 'peer');
                }
                return;
            }

            incomingFile.buffers.push(binaryChunk);
            incomingFile.received += binaryChunk.byteLength;
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (incomingFile.received >= incomingFile.size || now - lastProgressUpdate >= PROGRESS_UPDATE_THROTTLE_MS) {
                lastProgressUpdate = now;
                const percent = incomingFile.size ? (incomingFile.received / incomingFile.size) * 100 : 0;
                const prettyPercent = percent ? percent.toFixed(1) : '0.0';
                fileProgress.value = percent;
                fileProgressText.textContent = `Receiving "${incomingFile.name}" (${incomingFile.received} / ${incomingFile.size}) – ${prettyPercent}%`;
                if (fileProgressPercent) {
                    fileProgressPercent.textContent = `${prettyPercent}%`;
                }
            }

            if (incomingFile.received >= incomingFile.size) {
                const blob = new Blob(incomingFile.buffers);
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = incomingFile.name;
                link.textContent = `Download ${incomingFile.name} (${Math.round(incomingFile.size / 1024)} KB)`;
                const el = document.createElement('div');
                el.className = 'message peer';
                el.appendChild(link);
                messagesDiv.appendChild(el);
                messagesDiv.scrollTop = messagesDiv.scrollHeight;
                fileProgressText.textContent = `Received "${incomingFile.name}"`;
                fileProgress.value = 100;
                if (fileProgressPercent) {
                    fileProgressPercent.textContent = '100%';
                }
                clearReceiveState();
            }
        }
    });
}

createOfferBtn.addEventListener('click', async () => {
    isOfferer = true;
    createOfferBtn.disabled = true;
    createAnswerBtn.disabled = true;
    setRemoteBtn.disabled = true;

    const connection = setupPeerConnection({ createDataChannel: true });
    if (!connection) {
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    let offer;
    try {
        offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
    } catch (err) {
        showError('Failed to create offer. See console for details.', { alertUser: true });
        console.error('createOffer error', err);
        resetUI();
        return;
    }

    iceStatus.textContent = `ICE: gathering...`;

    // Wait until ICE gathering completes so we can share a complete SDP (no candidate exchange)
    const { complete: iceComplete, reason: iceReason } = await waitForIceGatheringComplete(pc);
    if (!iceComplete) {
        console.info(`ICE gathering did not finish before timeout (${iceReason}). Continuing with partial candidates.`);
        logMessage('ICE gathering took longer than expected; continuing with partial candidate set.', 'peer');
    }

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    setRemoteBtn.disabled = false;
    createAnswerBtn.disabled = true;

    updateIceStatus(iceComplete ? '' : '(partial)');
    updateConnStatus();

    if (ws) {
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    }
});

createAnswerBtn.addEventListener('click', async () => {
    const remoteText = remoteSDPTextarea.value.trim();

    if (useServer && ws && remoteText === '') {
        waitingForServerOffer = true;
        cleanupConnections({ closeWebSocket: false });
        const connection = setupPeerConnection({ createDataChannel: false });
        if (!connection) {
            createOfferBtn.disabled = false;
            createAnswerBtn.disabled = false;
            return;
        }
        isOfferer = false;
        createOfferBtn.disabled = true;
        createAnswerBtn.disabled = true;
        setRemoteBtn.disabled = true;
        logMessage('Waiting for offer from signaling server...', 'peer');
        return;
    }

    if (!remoteText) {
        showError('Remote SDP is empty. Paste the offer from your peer.', { alertUser: true, prefixLog: false });
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    await respondToOffer(remoteText, 'manual');
});

setRemoteBtn.addEventListener('click', async () => {
    await applyRemoteAnswer(remoteSDPTextarea.value.trim(), 'manual');
});

copyLocalBtn.addEventListener('click', async () => {
    try {
        await navigator.clipboard.writeText(localSDPTextarea.value);
        copyLocalBtn.textContent = 'Copied!';
        setTimeout(() => copyLocalBtn.textContent = 'Copy Local SDP', 1500);
    } catch (e) {
        // fallback select
        localSDPTextarea.select();
        document.execCommand('copy');
        copyLocalBtn.textContent = 'Copied!';
        setTimeout(() => copyLocalBtn.textContent = 'Copy Local SDP', 1500);
    }
});

if (copyAnswerBtn) {
    copyAnswerBtn.addEventListener('click', async () => {
        const text = localSDPTextarea.value.trim();
        if (!text) {
            showError('Nothing to copy yet. Generate an answer first.', { alertUser: true, prefixLog: false });
            return;
        }
        try {
            await navigator.clipboard.writeText(text);
            copyAnswerBtn.textContent = 'Copied!';
            setTimeout(() => copyAnswerBtn.textContent = 'Copy Local Answer', 1500);
        } catch (e) {
            localSDPTextarea.select();
            document.execCommand('copy');
            copyAnswerBtn.textContent = 'Copied!';
            setTimeout(() => copyAnswerBtn.textContent = 'Copy Local Answer', 1500);
        }
    });
}

sendMsgBtn.addEventListener('click', () => {
    const txt = msgInput.value.trim();
    if (!txt) return;
    if (!dc || dc.readyState !== 'open') {
        showError('DataChannel not open yet.', { alertUser: true, prefixLog: false });
        return;
    }
    dc.send(txt);
    logMessage(txt, 'me');
    msgInput.value = '';
});

msgInput.addEventListener('keyup', (e) => {
    if (e.key === 'Enter') sendMsgBtn.click();
});

fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!dc || dc.readyState !== 'open') {
        showError('DataChannel not open yet.', { alertUser: true, prefixLog: false });
        fileInput.value = '';
        return;
    }

    if (activeSend) {
        showError('Another file transfer is already in progress. Please wait until it completes.', { alertUser: true });
        fileInput.value = '';
        return;
    }

    const id = Date.now().toString(36);
    const meta = { type: 'file-meta', id, name: file.name, size: file.size };

    activeSend = {
        id,
        name: file.name,
        size: file.size,
        cancelRequested: false,
        cancelReason: '',
        peerCancelled: false,
        reader: null
    };

    setCancelAction(() => {
        if (!activeSend || activeSend.cancelRequested) return;
        activeSend.cancelRequested = true;
        activeSend.cancelReason = 'sender cancelled';
        sendFileSignal({ type: 'file-cancel', id: activeSend.id, name: activeSend.name, reason: 'sender cancelled' });
        if (activeSend.reader && activeSend.reader.cancel) {
            try { activeSend.reader.cancel('sender cancelled'); } catch (err) {
                console.warn('Failed to cancel file stream after sender cancellation', err);
            }
        }
    }, 'Cancel Send');

    try {
        ensureChannelOpen();
        dc.send(JSON.stringify(meta));
    } catch (err) {
        handleFileSendFailure(id, file.name, err?.message || 'failed to send metadata', activeSend);
        fileInput.value = '';
        return;
    }

    fileProgress.value = 0;
    fileProgress.max = 100;
    fileProgressText.textContent = `Sending "${file.name}" (0 / ${file.size}) – 0.0%`;
    if (fileProgressPercent) {
        fileProgressPercent.textContent = '0.0%';
    }
    lastProgressUpdate = 0;

    try {
        if (file.stream) {
            await sendFileFromStream(file);
        } else {
            await sendFileFromArrayBuffer(file);
        }
        fileProgressText.textContent = `Sent "${file.name}" (${file.size} bytes)`;
        fileProgress.value = 100;
        logMessage(`Sent file: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'me');
        activeSend = null;
        setCancelAction(null);
    } catch (err) {
        const reason = err?.message || 'transfer aborted';
        if (activeSend) {
            handleFileSendFailure(id, file.name, reason, activeSend);
        }
    } finally {
        fileInput.value = '';
    }
});

async function respondToOffer(remoteSource, origin = 'manual') {
    const wasWaiting = waitingForServerOffer;
    waitingForServerOffer = false;

    if (origin === 'server') {
        logMessage('Received offer from signaling server', 'peer');
    }

    let remoteDesc;
    try {
        remoteDesc = typeof remoteSource === 'string' ? JSON.parse(remoteSource) : remoteSource;
        validateSDP(remoteDesc);
    } catch (err) {
        console.error('Failed to parse or validate remote offer', err);
        if (origin === 'manual') {
            showError('Invalid remote offer. Please ensure you pasted the full SDP block.', { alertUser: true });
        } else {
            logMessage('Received malformed offer from signaling server', 'peer');
        }
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    if (pc && !wasWaiting) {
        cleanupConnections({ closeWebSocket: false });
    }

    if (!pc) {
        const connection = setupPeerConnection({ createDataChannel: false });
        if (!connection) {
            createOfferBtn.disabled = false;
            createAnswerBtn.disabled = false;
            return;
        }
    }

    isOfferer = false;
    createOfferBtn.disabled = true;
    createAnswerBtn.disabled = true;
    setRemoteBtn.disabled = true;

    try {
        await pc.setRemoteDescription(remoteDesc);
    } catch (err) {
        console.error('Failed to apply remote offer', err);
        if (origin === 'manual') {
            showError('Failed to apply remote offer. Please verify the SDP.', { alertUser: true });
        } else {
            logMessage('Failed to apply offer from signaling server', 'peer');
        }
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    try {
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
    } catch (err) {
        console.error('Failed to create or apply answer', err);
        showError('Failed to create answer. Please retry the connection.', { alertUser: origin === 'manual' });
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    iceStatus.textContent = `ICE: gathering...`;

    const { complete: iceComplete, reason: iceReason } = await waitForIceGatheringComplete(pc);
    if (!iceComplete) {
        console.info(`ICE gathering did not finish before timeout while creating answer (${iceReason}). Continuing.`);
        logMessage('ICE gathering took longer than expected while creating answer; continuing with partial candidate set.', 'peer');
    }

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    updateConnStatus();
    updateIceStatus(iceComplete ? '' : '(partial)');
    if (copyAnswerBtn) {
        copyAnswerBtn.hidden = false;
        copyAnswerBtn.disabled = false;
        copyAnswerBtn.textContent = 'Copy Local Answer';
    }

    if (useServer && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
        if (origin === 'server') {
            logMessage('Sent answer via signaling server', 'peer');
        }
    } else if (origin === 'server') {
        logMessage('Could not relay answer: signaling server connection closed', 'peer');
    }
}

async function applyRemoteAnswer(remoteSource, origin = 'manual') {
    if (!pc || !isOfferer) {
        if (origin === 'manual') {
            showError('No local offer in progress. Create an offer first on this side.', { alertUser: true, prefixLog: false });
        }
        return;
    }

    let remoteDesc;
    try {
        remoteDesc = typeof remoteSource === 'string' ? JSON.parse(remoteSource) : remoteSource;
        validateSDP(remoteDesc);
    } catch (err) {
        console.error('Failed to parse remote answer', err);
        if (origin === 'manual') {
            showError('Invalid remote answer. Make sure you pasted the entire SDP.', { alertUser: true });
        } else {
            logMessage('Received malformed answer from signaling server', 'peer');
        }
        return;
    }

    try {
        await pc.setRemoteDescription(remoteDesc);
        updateConnStatus();
        setRemoteBtn.disabled = true;
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        if (origin === 'server') {
            logMessage('Applied answer from signaling server', 'peer');
        }
    } catch (err) {
        console.error('Failed to apply remote answer', err);
        if (origin === 'manual') {
            showError('Failed to apply remote answer. Please double-check the SDP.', { alertUser: true });
        } else {
            logMessage('Failed to apply answer from signaling server', 'peer');
        }
    }
}
