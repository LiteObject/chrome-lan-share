// popup.js
// Simple manual-signaling WebRTC DataChannel for text & file transfer (chunked).
// Works inside the extension popup (DOM available).

const createOfferBtn = document.getElementById('createOffer');
const createAnswerBtn = document.getElementById('createAnswer');
const setRemoteBtn = document.getElementById('setRemote');
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

const useServerCheckbox = document.getElementById('useServer');
const connectServerBtn = document.getElementById('connectServer');
const serverIPInput = document.getElementById('serverIP');

let pc = null;
let dc = null;
let isOfferer = false;
let ws = null;
let useServer = false;

const CHUNK_SIZE = 64 * 1024; // 64KB

useServerCheckbox.addEventListener('change', () => {
    useServer = useServerCheckbox.checked;
    connectServerBtn.disabled = !useServer;
    if (!useServer && ws) {
        ws.close();
        ws = null;
    }
    // Toggle UI for manual vs server
    if (useServer) {
        localSDPTextarea.style.display = 'none';
        remoteSDPTextarea.style.display = 'none';
        copyLocalBtn.style.display = 'none';
        setRemoteBtn.style.display = 'none';
        createAnswerBtn.textContent = 'Wait for Offer';
        createOfferBtn.disabled = !!ws; // disable if not connected
        createAnswerBtn.disabled = !!ws;
    } else {
        localSDPTextarea.style.display = 'block';
        remoteSDPTextarea.style.display = 'block';
        copyLocalBtn.style.display = 'inline-block';
        setRemoteBtn.style.display = 'inline-block';
        createAnswerBtn.textContent = 'Set Remote / Create Answer';
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
    }
});

connectServerBtn.addEventListener('click', () => {
    if (ws) ws.close();
    const serverAddr = 'ws://' + serverIPInput.value;
    ws = new WebSocket(serverAddr);
    ws.onopen = () => {
        logMessage('Connected to signaling server at ' + serverAddr, 'peer');
        connectServerBtn.textContent = 'Connected';
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
    };
    ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === 'offer') {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            if (!isOfferer) {
                createAnswerBtn.click();
            }
        } else if (data.type === 'answer') {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            setRemoteBtn.click();
        }
    };
    ws.onclose = () => {
        logMessage('Disconnected from signaling server', 'peer');
        connectServerBtn.textContent = 'Connect to Server';
        ws = null;
        if (useServer) {
            createOfferBtn.disabled = true;
            createAnswerBtn.disabled = true;
        }
    };
    ws.onerror = (error) => {
        logMessage('Failed to connect to signaling server at ' + serverAddr, 'peer');
        console.error(error);
    };
});

function logMessage(text, who = 'peer') {
    const el = document.createElement('div');
    el.className = `message ${who === 'me' ? 'me' : 'peer'}`;
    el.textContent = text;
    messagesDiv.appendChild(el);
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function waitForIceGatheringComplete(pc) {
    return new Promise((resolve) => {
        if (pc.iceGatheringState === 'complete') {
            resolve();
        } else {
            function checkState() {
                if (pc.iceGatheringState === 'complete') {
                    pc.removeEventListener('icegatheringstatechange', checkState);
                    resolve();
                }
            }
            pc.addEventListener('icegatheringstatechange', checkState);
        }
    });
}

function updateConnStatus() {
    if (!pc) { connStatus.textContent = 'Conn: —'; return; }
    connStatus.textContent = `Conn: ${pc.connectionState || '—'}`;
}

// Setup a new RTCPeerConnection and optionally create DataChannel
function setupPeerConnection({ createDataChannel = false } = {}) {
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' }
        ]
    });

    pc.addEventListener('iceconnectionstatechange', () => {
        updateConnStatus();
    });

    pc.addEventListener('connectionstatechange', () => {
        updateConnStatus();
    });

    pc.addEventListener('icecandidate', (evt) => {
        // we wait for gathering complete and then expose SDP, so nothing here.
        iceStatus.textContent = `ICE: ${pc.iceGatheringState}`;
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

    return pc;
}

function setupDataChannel(channel) {
    channel.binaryType = 'arraybuffer';
    channel.addEventListener('open', () => {
        logMessage('DataChannel open', 'peer');
        updateConnStatus();
    });
    channel.addEventListener('close', () => {
        logMessage('DataChannel closed', 'peer');
        updateConnStatus();
    });

    // File assembly state
    let incomingFile = null; // {id, name, size, received, buffers: []}

    channel.addEventListener('message', (evt) => {
        // If it's string -> control message or text message
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
                    fileProgress.textContent = `Receiving "${incomingFile.name}" (0 / ${incomingFile.size})`;
                    return;
                }
            } catch (e) {
                // Not JSON -> treat as plain chat text
            }

            // plain chat string
            logMessage(evt.data, 'peer');
            return;
        }

        // Binary chunk
        if (evt.data instanceof ArrayBuffer) {
            if (!incomingFile) {
                console.warn('Received binary without metadata - ignoring');
                return;
            }
            incomingFile.buffers.push(evt.data);
            incomingFile.received += evt.data.byteLength;
            fileProgress.textContent = `Receiving "${incomingFile.name}" (${incomingFile.received} / ${incomingFile.size})`;

            if (incomingFile.received >= incomingFile.size) {
                // assemble
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
                fileProgress.textContent = `Received "${incomingFile.name}"`;
                incomingFile = null;
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
    await waitForIceGatheringComplete(pc);

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    setRemoteBtn.disabled = false;
    createAnswerBtn.disabled = true;

    iceStatus.textContent = `ICE: ${pc.iceGatheringState}`;
    updateConnStatus();

    if (ws) {
        ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    }
});

createAnswerBtn.addEventListener('click', async () => {
    // This path: set remote (offer) and create answer for it
    // For safety, if pc exists, reset it
    if (pc) {
        try { pc.close(); } catch (e) { }
        pc = null;
        dc = null;
    }
    isOfferer = false;
    createOfferBtn.disabled = true;
    createAnswerBtn.disabled = true;
    setRemoteBtn.disabled = true;

    setupPeerConnection({ createDataChannel: false });

    try {
        const remote = JSON.parse(remoteSDPTextarea.value.trim());
        await pc.setRemoteDescription(remote);
    } catch (e) {
        alert('Invalid remote SDP JSON. Make sure you pasted the offer.');
        createOfferBtn.disabled = false;
        return;
    }

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    iceStatus.textContent = `ICE: gathering...`;

    await waitForIceGatheringComplete(pc);

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    updateConnStatus();
    iceStatus.textContent = `ICE: ${pc.iceGatheringState}`;
    // Now user copies local SDP and gives it to offerer

    if (ws) {
        ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription }));
    }
});

setRemoteBtn.addEventListener('click', async () => {
    // For offerer: set remote answer
    if (!pc || !isOfferer) {
        alert('No local offer in progress. Create an offer first on this side.');
        return;
    }
    try {
        const remote = JSON.parse(remoteSDPTextarea.value.trim());
        await pc.setRemoteDescription(remote);
        updateConnStatus();
        setRemoteBtn.disabled = true;
        createOfferBtn.disabled = false;
        createAnswerBtn.disabled = false;
    } catch (e) {
        alert('Invalid remote SDP JSON. Make sure you pasted the answer.');
        console.error(e);
    }
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
        return;
    }

    const id = Date.now().toString(36);
    // send file metadata as JSON string
    const meta = { type: 'file-meta', id, name: file.name, size: file.size };
    dc.send(JSON.stringify(meta));

    // read and send in chunks
    const stream = file.stream();
    const reader = stream.getReader();
    let sent = 0;
    fileProgress.textContent = `Sending "${file.name}" (0 / ${file.size})`;
    while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        // value is Uint8Array
        // ensure chunk size — but the browser will usually chunk naturally; still send slices if large
        let offset = 0;
        while (offset < value.byteLength) {
            const slice = value.slice(offset, offset + CHUNK_SIZE);
            dc.send(slice.buffer);
            sent += slice.byteLength;
            offset += slice.byteLength;
            fileProgress.textContent = `Sending "${file.name}" (${sent} / ${file.size})`;
            // optionally await a tiny pause to avoid saturating
            await new Promise(r => setTimeout(r, 0));
        }
    }
    fileProgress.textContent = `Sent "${file.name}" (${file.size} bytes)`;
    logMessage(`Sent file: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'me');
    // reset file input
    fileInput.value = '';
});
