// popup.js
// Simple manual-signaling WebRTC DataChannel for text & file transfer (chunked).
// Works inside the extension popup (DOM available).

const createOfferBtn = document.getElementById('createOffer');
const createAnswerBtn = document.getElementById('createAnswer');
const setRemoteBtn = document.getElementById('setRemote');
const disconnectBtn = document.getElementById('disconnect');
const localSDPTextarea = document.getElementById('localSDP');
const remoteSDPTextarea = document.getElementById('remoteSDP');
const copyLocalBtn = document.getElementById('copyLocal');
const iceStatus = document.getElementById('iceStatus');
const connStatus = document.getElementById('connStatus');

const messagesDiv = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendMsgBtn = document.getElementById('sendMsg');

const fileInput = document.getElementById('fileInput');
const fileProgress = document.getElementById('fileProgress');
const fileProgressText = document.getElementById('fileProgressText');
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
const ICE_GATHER_TIMEOUT_MS = 5000;

let pc = null;
let dc = null;
let isOfferer = false;
let ws = null;
let useServer = false;
let waitingForServerOffer = false;
let activeSend = null;
let cancelCurrentTransfer = null;

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
        if (!url.port) {
            // leave port empty if user provided hostname only
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
    return new Promise((resolve) => setTimeout(resolve, 0));
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
        }, 50);

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
        }, 5000);

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
    ensureChannelOpen();
    channel.send(chunk);
    if (channel.bufferedAmount > BUFFERED_AMOUNT_LIMIT) {
        await waitForSendWindow(state, channel);
    } else {
        await waitForNextMicrotask();
    }
}

function updateSendProgress(file, sent) {
    const percent = file.size ? (sent / file.size) * 100 : 0;
    fileProgress.value = percent;
    const prettyPercent = percent ? percent.toFixed(1) : '0.0';
    fileProgressText.textContent = `Sending "${file.name}" (${sent} / ${file.size}) – ${prettyPercent}%`;
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
                await sendChunk(slice, sendState);
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

useServerCheckbox.addEventListener('change', () => {
    useServer = useServerCheckbox.checked;
    waitingForServerOffer = false;
    if (!useServer && ws) {
        ws.close();
        ws = null;
    }
    updateSignalingUI();
});

disconnectBtn.addEventListener('click', () => {
    if (activeSend) {
        handleFileSendFailure(activeSend.id, activeSend.name, 'connection reset', activeSend);
    }
    if (dc) {
        try { dc.close(); } catch (err) { console.error(err); }
        dc = null;
    }
    if (pc) {
        try { pc.close(); } catch (err) { console.error(err); }
        pc = null;
    }
    isOfferer = false;
    waitingForServerOffer = false;
    resetUI();
    logMessage('Connection reset by user', 'peer');
});

connectServerBtn.addEventListener('click', () => {
    if (!useServer) {
        alert('Enable "Use Signaling Server" before connecting.');
        return;
    }

    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
        return;
    }

    const normalized = normalizeServerAddress(serverIPInput.value);
    if (!normalized) {
        alert('Please enter a valid WebSocket address (e.g., ws://localhost:8080).');
        return;
    }

    let socket;
    try {
        socket = new WebSocket(normalized);
    } catch (err) {
        console.error('Failed to initiate WebSocket', err);
        alert('Invalid WebSocket URL. Please verify the address and try again.');
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
    return new Promise((resolve) => {
        if (peer.iceGatheringState === 'complete') {
            resolve(true);
            return;
        }

        let resolved = false;

        const finalize = (complete) => {
            if (resolved) return;
            resolved = true;
            peer.removeEventListener('icegatheringstatechange', onChange);
            clearTimeout(timeout);
            resolve(complete);
        };

        const onChange = () => {
            if (peer.iceGatheringState === 'complete') {
                finalize(true);
            } else {
                updateIceStatus();
            }
        };

        const timeout = setTimeout(() => {
            finalize(false);
        }, timeoutMs);

        peer.addEventListener('icegatheringstatechange', onChange);
    });
}

function updateConnStatus() {
    const pcState = pc ? pc.connectionState || '—' : '—';
    const dcState = dc ? dc.readyState : '—';
    connStatus.textContent = `Conn: ${pcState} | DC: ${dcState}`;
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

// Setup a new RTCPeerConnection and optionally create DataChannel
function setupPeerConnection({ createDataChannel = false } = {}) {
    dc = null;
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

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
        resetUI();
        clearReceiveState('Transfer cancelled.', { allowOrphanChunks: true });
    });

    channel.addEventListener('message', async (evt) => {
        if (typeof evt.data === 'string') {
            try {
                const obj = JSON.parse(evt.data);
                if (obj && obj.type === 'file-meta') {
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
                    fileProgressText.textContent = `Receiving "${incomingFile.name}" (0 / ${incomingFile.size}) – 0.0%`;
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
            const percent = incomingFile.size ? (incomingFile.received / incomingFile.size) * 100 : 0;
            const prettyPercent = percent ? percent.toFixed(1) : '0.0';
            fileProgress.value = percent;
            fileProgressText.textContent = `Receiving "${incomingFile.name}" (${incomingFile.received} / ${incomingFile.size}) – ${prettyPercent}%`;

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

    setupPeerConnection({ createDataChannel: true });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    iceStatus.textContent = `ICE: gathering...`;

    // Wait until ICE gathering completes so we can share a complete SDP (no candidate exchange)
    const iceComplete = await waitForIceGatheringComplete(pc);

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    setRemoteBtn.disabled = false;
    createAnswerBtn.disabled = true;

    updateIceStatus(iceComplete ? '' : '(timeout)');
    if (!iceComplete) {
        logMessage('ICE gathering timed out; using partial candidate set.', 'peer');
    }
    updateConnStatus();

    if (ws) {
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    }
});

createAnswerBtn.addEventListener('click', async () => {
    const remoteText = remoteSDPTextarea.value.trim();

    if (useServer && ws && remoteText === '') {
        waitingForServerOffer = true;
        if (pc) {
            try { pc.close(); } catch (e) { }
            pc = null;
            dc = null;
        }
        setupPeerConnection({ createDataChannel: false });
        isOfferer = false;
        createOfferBtn.disabled = true;
        createAnswerBtn.disabled = true;
        setRemoteBtn.disabled = true;
        logMessage('Waiting for offer from signaling server...', 'peer');
        return;
    }

    if (!remoteText) {
        alert('Remote SDP is empty. Paste the offer from your peer.');
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

sendMsgBtn.addEventListener('click', () => {
    const txt = msgInput.value.trim();
    if (!txt) return;
    if (!dc || dc.readyState !== 'open') {
        alert('DataChannel not open yet.');
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
        alert('DataChannel not open yet.');
        fileInput.value = '';
        return;
    }

    if (activeSend) {
        alert('Another file transfer is already in progress. Please wait until it completes.');
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
    } catch (err) {
        console.error('Failed to parse remote offer', err);
        if (origin === 'manual') {
            alert('Invalid remote SDP JSON. Make sure you pasted the offer.');
        } else {
            logMessage('Received malformed offer from signaling server', 'peer');
        }
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    if (pc && !wasWaiting) {
        try { pc.close(); } catch (err) { }
        pc = null;
        dc = null;
    }

    if (!pc) {
        setupPeerConnection({ createDataChannel: false });
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
            alert('Failed to apply remote offer. Please verify the SDP.');
        } else {
            logMessage('Failed to apply offer from signaling server', 'peer');
        }
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
        return;
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    iceStatus.textContent = `ICE: gathering...`;

    const iceComplete = await waitForIceGatheringComplete(pc);

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    updateConnStatus();
    updateIceStatus(iceComplete ? '' : '(timeout)');
    if (!iceComplete) {
        logMessage('ICE gathering timed out while creating answer; using partial candidate set.', 'peer');
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
            alert('No local offer in progress. Create an offer first on this side.');
        }
        return;
    }

    let remoteDesc;
    try {
        remoteDesc = typeof remoteSource === 'string' ? JSON.parse(remoteSource) : remoteSource;
    } catch (err) {
        console.error('Failed to parse remote answer', err);
        if (origin === 'manual') {
            alert('Invalid remote SDP JSON. Make sure you pasted the answer.');
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
            alert('Invalid remote SDP JSON. Make sure you pasted the answer.');
        } else {
            logMessage('Failed to apply answer from signaling server', 'peer');
        }
    }
}
