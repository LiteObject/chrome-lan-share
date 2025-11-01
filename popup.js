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

const useServerCheckbox = document.getElementById('useServer');
const connectServerBtn = document.getElementById('connectServer');
const serverIPInput = document.getElementById('serverIP');
const darkModeToggle = document.getElementById('darkModeToggle');

const setupTab = document.getElementById('setupTab');
const chatTab = document.getElementById('chatTab');
const setupContent = document.getElementById('setupContent');
const chatContent = document.getElementById('chatContent');

let pc = null;
let dc = null;
let isOfferer = false;
let ws = null;
let useServer = false;
let waitingForServerOffer = false;

function resetUI() {
    iceStatus.textContent = 'ICE: —';
    updateConnStatus();
    copyLocalBtn.disabled = true;
    setRemoteBtn.disabled = true;
    createOfferBtn.disabled = useServer && !ws;
    createAnswerBtn.disabled = useServer && !ws;
    localSDPTextarea.value = '';
    remoteSDPTextarea.value = '';
    fileProgress.value = 0;
    fileProgressText.textContent = '';
    waitingForServerOffer = false;
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
        // disable offer/answer until we have a WS connection
        createOfferBtn.disabled = !ws;
        createAnswerBtn.disabled = !ws;
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

disconnectBtn.addEventListener('click', () => {
    if (dc) {
        try { dc.close(); } catch (err) { console.error(err); }
        dc = null;
    }
    if (pc) {
        try { pc.close(); } catch (err) { console.error(err); }
        pc = null;
    }
    isOfferer = false;
    resetUI();
    logMessage('Connection reset by user', 'peer');
});

connectServerBtn.addEventListener('click', () => {
    if (ws) ws.close();
    const addr = serverIPInput.value.trim();
    if (!addr || !addr.includes(':')) {
        alert('Please enter a valid server address (e.g., localhost:8080 or 192.168.1.100:8080)');
        return;
    }
    const serverAddr = 'ws://' + addr;
    ws = new WebSocket(serverAddr);
    ws.onopen = () => {
        logMessage('Connected to signaling server at ' + serverAddr, 'peer');
        connectServerBtn.textContent = 'Connected';
        if (useServer) {
            createOfferBtn.disabled = false;
            createAnswerBtn.disabled = false;
        }
    };
    ws.onmessage = async (event) => {
        let payload = event.data;
        if (payload instanceof Blob) {
            payload = await payload.text();
        }
        if (payload instanceof ArrayBuffer) {
            payload = new TextDecoder().decode(payload);
        }

        const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
        if (data.type === 'offer') {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            if (!isOfferer) {
                try {
                    await respondToOffer(data.sdp, 'server');
                } catch (err) {
                    console.error('Failed to handle offer from server', err);
                }
            }
        } else if (data.type === 'answer') {
            remoteSDPTextarea.value = JSON.stringify(data.sdp);
            if (isOfferer) {
                try {
                    await applyRemoteAnswer(data.sdp, 'server');
                } catch (err) {
                    console.error('Failed to apply answer from server', err);
                }
            }
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
        resetUI();
    };
    ws.onerror = (error) => {
        logMessage('Failed to connect to signaling server at ' + serverAddr, 'peer');
        console.error(error);
    };
});

function logMessage(text, who = 'peer') {
    const el = document.createElement('div');
    el.className = `message ${who === 'me' ? 'me' : 'peer'}`;
    const timestamp = new Date().toLocaleTimeString();
    el.textContent = `[${timestamp}] ${text}`;
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

    pc.addEventListener('iceconnectionstatechange', () => {
        if (pc.iceConnectionState === 'disconnected' || pc.iceConnectionState === 'failed') {
            logMessage('ICE connection lost', 'peer');
        }
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
        resetUI();
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
                    fileProgressText.textContent = `Receiving "${incomingFile.name}" (0 / ${incomingFile.size})`;
                    fileProgress.value = 0;
                    fileProgress.max = 100;
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
            const percent = (incomingFile.received / incomingFile.size) * 100;
            fileProgress.value = percent;
            fileProgressText.textContent = `Receiving "${incomingFile.name}" (${incomingFile.received} / ${incomingFile.size})`;

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
                fileProgressText.textContent = `Received "${incomingFile.name}"`;
                fileProgress.value = 100;
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
        return;
    }

    const id = Date.now().toString(36);
    const meta = { type: 'file-meta', id, name: file.name, size: file.size };
    dc.send(JSON.stringify(meta));
    fileProgressText.textContent = `Sending "${file.name}" (0 / ${file.size})`;
    fileProgress.value = 0;
    fileProgress.max = 100;

    // prefer stream(), fallback to FileReader
    if (file.stream) {
        const stream = file.stream();
        const reader = stream.getReader();
        let sent = 0;
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            let offset = 0;
            while (offset < value.byteLength) {
                const slice = value.slice(offset, offset + CHUNK_SIZE);
                dc.send(slice.buffer);
                sent += slice.byteLength;
                offset += slice.byteLength;
                const percent = (sent / file.size) * 100;
                fileProgress.value = percent;
                fileProgressText.textContent = `Sending "${file.name}" (${sent} / ${file.size})`;
                await new Promise(r => setTimeout(r, 0));
            }
        }
    } else {
        // FileReader fallback
        let offset = 0;
        const reader = new FileReader();
        reader.addEventListener('load', async (evt) => {
            const buffer = evt.target.result;
            let off = 0;
            while (off < buffer.byteLength) {
                const end = Math.min(off + CHUNK_SIZE, buffer.byteLength);
                const chunk = buffer.slice(off, end);
                dc.send(chunk);
                off = end;
                const percent = ((off + offset) / file.size) * 100;
                fileProgress.value = percent;
                fileProgressText.textContent = `Sending "${file.name}" (${Math.min(off + offset, file.size)} / ${file.size})`;
                await new Promise(r => setTimeout(r, 0));
            }
            // continue until all read
            if (offset < file.size) {
                readSlice(offset);
            } else {
                fileProgressText.textContent = `Sent "${file.name}" (${file.size} bytes)`;
                fileProgress.value = 100;
                logMessage(`Sent file: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'me');
                fileInput.value = '';
            }
        });

        function readSlice(o) {
            offset = o;
            const slice = file.slice(offset, offset + CHUNK_SIZE);
            reader.readAsArrayBuffer(slice);
        }
        readSlice(0);
    }

    if (file.stream) {
        fileProgressText.textContent = `Sent "${file.name}" (${file.size} bytes)`;
        fileProgress.value = 100;
        logMessage(`Sent file: ${file.name} (${Math.round(file.size / 1024)} KB)`, 'me');
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

    await waitForIceGatheringComplete(pc);

    localSDPTextarea.value = JSON.stringify(pc.localDescription);
    copyLocalBtn.disabled = false;
    updateConnStatus();
    iceStatus.textContent = `ICE: ${pc.iceGatheringState}`;

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
