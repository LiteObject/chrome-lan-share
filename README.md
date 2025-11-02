# Chrome LAN Share

Peer-to-peer message & file sharing Chrome extension for LAN use.  
Implements WebRTC (Web Real-Time Communication) DataChannel with **manual or automated signaling** (copy/paste SDP or local WebSocket server). No server required for manual mode.

## Project Structure
- `manifest.json` – Chrome MV3 configuration for the extension.
- `background.js` – Service worker that opens the side panel when the action icon is clicked.
- `sidepanel.html` – Main user interface loaded inside Chrome's side panel.
- `sidepanel.js` – WebRTC signaling, DataChannel messaging, and file transfer logic.
- `styles.css` – Light/dark theme styling, connection state badges, and layout rules.
- `server.js` – Optional local WebSocket relay for automated signaling on a LAN.
- `docs/nat-traversal-overview.md` – A friendly primer on STUN, TURN, and ICE.

## How to install (developer mode)
1. Save the project folder (contains `manifest.json`, `sidepanel.html`, `sidepanel.js`, `styles.css`).
2. In Chrome, go to `chrome://extensions/` → enable **Developer mode** → **Load unpacked** → select the folder.
3. Click the extension icon to open the side panel on two (or more) machines on your LAN. The panel stays active while it remains visible.

## Quick usage

### Manual Signaling (Default)
- On Device A: Click **Create Offer**. Wait for ICE (Interactive Connectivity Establishment) gathering to complete (status shows "ICE: complete"). The Local SDP (Session Description Protocol) textarea will populate with the offer. Click **Copy Local SDP** (or manually copy the text), then paste it into Device B's Remote SDP textarea.
- On Device B: Paste the offer into Remote SDP, then click **Set Remote / Create Answer**. The Local SDP textarea will populate with the answer. Copy it and paste back into Device A's Remote SDP.
- On Device A: Paste the answer into Remote SDP, then click **Set Remote**.
- Wait until DataChannel opens (status updates), then send messages & files.

### Automated Signaling (Optional)
- Install dependencies: Run `npm install` in the project directory.
- Run the server: `npm start` or `node server.js` on a machine accessible to both devices (it binds to 0.0.0.0 for LAN access).
- On both devices: Check "Use Signaling Server", enter the server address (e.g., `192.168.1.100:8080` for remote, or `localhost:8080` for local), and click "Connect to Server".
- On Device A: Click **Create Offer**.
- On Device B: Click **Wait for Offer**.
- Connections establish automatically without manual copying.

### Side Panel Workflow
- The extension opens inside Chrome's side panel (Chrome 116+) so the UI persists while you browse other tabs.
- If the side panel is closed, the WebRTC connection tears down just like closing the popup would.
- You can toggle the panel from the extension icon or via Chrome's side panel shortcut (`Ctrl+Shift+.` / `Cmd+Shift+.`) and selecting **Chrome LAN Share** from the drop-down.

### File Transfers
- Click **Send File** to pick a file; progress appears directly beneath the button.
- A **Cancel Transfer** button shows while you are sending, and a **Cancel Receive** button appears while you are receiving—use these to safely abort stalled transfers.
- When a file finishes downloading, the receiver gets a link (e.g. “Download example.zip”). Click it to trigger Chrome's download prompt; extensions cannot auto-save files.
- Only one outgoing transfer per browser runs at a time. You can still exchange uploads simultaneously (each peer sending one file).

## User Interface
- **Setup / Chat Tabs** – Configure signaling on the Setup tab, then switch to Chat once connected.
- **Connection Status Badges** – A pill next to the ICE status shows `[OK]` connected, `[...]` connecting, `[ERR]` failed, or `[--]` idle.
- **Progress Meter** – File transfers display both a progress bar and a percentage label; cancel buttons appear while transfers are active.
- **Keyboard Shortcuts** – `Ctrl/Cmd + D` disconnects the current session; `Esc` cancels an in-flight file transfer (when the cancel button is visible).
- **Dark Mode** – Toggle 🌙 in the header to switch themes.

## How It Works: WebRTC & SDP

This extension is built on two core web technologies: **WebRTC** and **SDP**.

### WebRTC (Web Real-Time Communication)

WebRTC is a technology that enables web browsers to stream audio, video, and arbitrary data in real-time directly to each other (peer-to-peer). This means data can be sent from one browser directly to another without passing through a central server.

In this extension, we use:
-   **`RTCPeerConnection`**: To establish and manage the connection between two users on the LAN.
-   **`RTCDataChannel`**: To create a communication channel for sending text messages and file chunks.

### SDP (Session Description Protocol)

Before two browsers can connect via WebRTC, they need to exchange information about the connection. This process is called **signaling**, and the information they exchange is formatted using **SDP**.

An SDP message is a block of text that describes the session, answering questions like:
-   What kind of data are we sending (e.g., a data channel)?
-   What are the network addresses where I might be reachable (known as ICE candidates)?
-   What security protocols will we use?

This extension uses **manual signaling**: you are the signaling server! By copying the "offer" SDP from one peer and pasting it into the other, and then copying the "answer" SDP back, you are providing both browsers with the information they need to find each other and establish a direct connection.

The communication flow looks like this:

```mermaid
sequenceDiagram
    participant User
    participant Peer A
    participant Peer B

    User->>Peer A: 1. Clicks "Create Offer"
    Peer A->>Peer A: Generates SDP Offer
    Note right of Peer A: pc.createOffer()
    Peer A-->>User: Displays Local SDP (Offer)

    User->>User: 2. Copies Offer from A
    User->>Peer B: 3. Pastes Offer into B

    User->>Peer B: 4. Clicks "Set Remote / Create Answer"
    Peer B->>Peer B: Processes Offer & Generates Answer
    Note left of Peer B: pc.setRemoteDescription(offer)<br/>pc.createAnswer()
    Peer B-->>User: Displays Local SDP (Answer)

    User->>User: 5. Copies Answer from B
    User->>Peer A: 6. Pastes Answer into A

    User->>Peer A: 7. Clicks "Set Remote"
    Peer A->>Peer A: Processes Answer
    Note right of Peer A: pc.setRemoteDescription(answer)

    Peer A->>Peer B: 8. Direct connection established (ICE & DTLS)
    Note over Peer A, Peer B: DataChannel is now open

```

## Notes & limitations
- Files are sent via ordered DataChannel and reconstructed on the receiver.
- For more convenience, automated signaling via a local WebSocket server is supported (optional).
- Transfers cancel cleanly if either side closes the side panel or hits **Cancel**; progress text updates to reflect the reason.

### Connecting Over the Internet (NAT Traversal)

By default, this extension is configured for local network (LAN/Wi-Fi) use with basic internet support via STUN. The `iceServers` list in the WebRTC configuration includes a public STUN server.

-   **ICE (Interactive Connectivity Establishment)** is the process WebRTC uses to find the best path to connect peers. It does this by gathering network addresses (candidates).
-   With the STUN server, it can gather public IP addresses, allowing connections over the internet in many cases.

For more reliable internet connections, you can add a TURN server to the configuration in `sidepanel.js`:

```javascript
// in sidepanel.js
pc = new RTCPeerConnection({
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }  // Replace with actual TURN server
    ]
});
```

## Security
- Only exchange SDP with trusted devices.
- This demo does not include authentication — for production, add pairing tokens or passcodes and encryption.

## Troubleshooting
- **“Receiving failed: missing metadata. Requested peer to resend.”** — The receiver saw file data before the header (usually after a cancel or network blip). The sender will stop automatically; resend the file once both sides show idle progress.
- If progress counts race far past the expected file size, reload the extension (`chrome://extensions/` → **Reload**) to ensure both peers have the latest code.
- **“DataChannel not open yet.”** — Complete the full offer/answer exchange (or connect both peers to the signaling server) before sending messages or files.
- **File transfer stalls near 100%.** — Hit **Cancel Transfer** on both sides, then resend. Large files on slow links may expose network limits; try again after a pause.
- **“Failed to connect to signaling server.”** — Confirm the address includes a port (e.g., `192.168.1.10:8080`), that `server.js` is running, and that firewall rules allow WebSocket traffic.
- Reloading the extension is a quick way to clear any stuck state if peers drift out of sync.

## Learn More
- 📖 [`docs/nat-traversal-overview.md`](docs/nat-traversal-overview.md) for a gentle primer on NAT traversal, STUN, TURN, and ICE.
- 🛠️ [`server.js`](server.js) demonstrates a minimal WebSocket relay for automated SDP exchange on a LAN.

## License
This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.
