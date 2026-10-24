/* Veil — local LSB steganography + Pollinations AI covers and the Fable game. */
(() => {
    "use strict";

    const GEN = "https://gen.pollinations.ai";
    const ENTER = "https://enter.pollinations.ai";
    const KEY_STORE = "veil.key";
    const TEXT_MODEL = "openai";
    const IMAGE_MODEL = "flux";
    const MAX_SIDE = 2048;
    const HEADER_BYTES = 64;
    const HEADER_BITS = HEADER_BYTES * 8;

    const $ = (id) => document.getElementById(id);
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    function setStatus(el, text, kind) {
        el.textContent = text || "";
        el.className = `status${kind ? ` is-${kind}` : ""}`;
    }

    /* ------------------------------ auth ------------------------------ */

    let authPoll = 0;
    let authTimer = null;

    function getKey() {
        try {
            return sessionStorage.getItem(KEY_STORE) || "";
        } catch {
            return "";
        }
    }

    function setKey(key) {
        try {
            sessionStorage.setItem(KEY_STORE, key);
        } catch {
            /* private mode: keep it in memory for this page only */
        }
        authKey = key;
        updateAuth();
    }

    let authKey = getKey();

    function clearKey() {
        authKey = "";
        try {
            sessionStorage.removeItem(KEY_STORE);
        } catch {
            /* ignore */
        }
        updateAuth();
    }

    function updateAuth() {
        const on = Boolean(authKey);
        $("connectBtn").classList.toggle("is-on", on);
        $("connectDot").hidden = false;
        $("connectLabel").textContent = on ? "Connected" : "Connect Pollinations";
    }

    function openAuth() {
        $("authModal").hidden = false;
        $("pasteKey").value = "";
        setStatus($("pasteStatus"), "");
        if (authKey) {
            $("deviceBox").hidden = true;
        }
    }

    function closeAuth() {
        $("authModal").hidden = true;
        authPoll += 1;
        if (authTimer) clearTimeout(authTimer);
    }

    async function startDeviceFlow() {
        const box = $("deviceBox");
        box.hidden = false;
        setStatus($("deviceStatus"), "Requesting a device code…");

        let data;
        try {
            const res = await fetch(`${ENTER}/api/device/code`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: "{}",
            });
            data = await res.json();
            if (!res.ok || !data.device_code) {
                throw new Error(data?.error_description || data?.error || `HTTP ${res.status}`);
            }
        } catch (error) {
            setStatus($("deviceStatus"), error.message || "Could not start the device flow.", "error");
            return;
        }

        $("deviceCode").textContent = data.user_code;
        $("deviceLink").href = data.verification_uri_complete || data.verification_uri;
        setStatus($("deviceStatus"), "Waiting for approval…");

        const token = ++authPoll;
        const interval = Math.max(3, Number(data.interval) || 5) * 1000;

        const poll = async () => {
            if (token !== authPoll || $("authModal").hidden) return;
            try {
                const res = await fetch(`${ENTER}/api/device/token`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ device_code: data.device_code }),
                });
                const payload = await res.json();
                if (payload.access_token) {
                    setKey(payload.access_token);
                    setStatus($("deviceStatus"), "Connected. This key lives only in this tab.", "ok");
                    setTimeout(closeAuth, 900);
                    return;
                }
                if (payload.error === "slow_down") {
                    authTimer = setTimeout(poll, interval + 5000);
                    return;
                }
                if (payload.error && payload.error !== "authorization_pending") {
                    setStatus($("deviceStatus"), payload.error_description || payload.error, "error");
                    return;
                }
            } catch {
                /* transient network error: keep polling */
            }
            authTimer = setTimeout(poll, interval);
        };

        authTimer = setTimeout(poll, interval);
    }

    /* ------------------------------ AI ------------------------------ */

    async function chat(messages, options = {}) {
        if (!authKey) throw new Error("Connect Pollinations first.");
        const res = await fetch(`${GEN}/v1/chat/completions`, {
            method: "POST",
            headers: { authorization: `Bearer ${authKey}`, "content-type": "application/json" },
            body: JSON.stringify({
                model: options.model || TEXT_MODEL,
                messages,
                max_tokens: options.maxTokens || 900,
                temperature: options.temperature ?? 0.8,
            }),
        });
        const payload = await res.json().catch(() => null);
        if (!res.ok) {
            throw new Error(payload?.error?.message || `Pollinations returned HTTP ${res.status}.`);
        }
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) {
            throw new Error("The model returned an empty reply. Try again.");
        }
        return content.trim();
    }

    async function generateCover(prompt) {
        if (!authKey) throw new Error("Connect Pollinations first.");
        const url = `${GEN}/image/${encodeURIComponent(prompt)}?model=${IMAGE_MODEL}&width=1024&height=1024&seed=${Math.floor(Math.random() * 1e6)}`;
        const res = await fetch(url, { headers: { authorization: `Bearer ${authKey}` } });
        if (!res.ok) {
            const payload = await res.json().catch(() => null);
            throw new Error(payload?.error?.message || `Image request failed (HTTP ${res.status}).`);
        }
        return await res.blob();
    }

    /* --------------------------- image helpers --------------------------- */

    async function toCanvas(source) {
        const bitmap = await createImageBitmap(source);
        const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
        const width = Math.max(8, Math.round(bitmap.width * scale));
        const height = Math.max(8, Math.round(bitmap.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        context.drawImage(bitmap, 0, 0, width, height);
        bitmap.close?.();
        return canvas;
    }

    function canvasToBlob(canvas) {
        return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    }

    /* ------------------------------ stego ------------------------------ */

    let crcTable = null;

    function crc32(bytes) {
        if (!crcTable) {
            crcTable = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
                crcTable[n] = c >>> 0;
            }
        }
        let crc = 0xffffffff;
        for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        return (crc ^ 0xffffffff) >>> 0;
    }

    function gcd(a, b) {
        while (b) [a, b] = [b, a % b];
        return a;
    }

    function seededRandom(seed) {
        let state = seed >>> 0;
        return () => {
            state = (state + 0x6d2b79f5) | 0;
            let t = Math.imul(state ^ (state >>> 15), 1 | state);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    function seedFrom(bytes) {
        let hash = 2166136261;
        for (const byte of bytes) {
            hash ^= byte;
            hash = Math.imul(hash, 16777619);
        }
        return hash >>> 0;
    }

    // A permutation of [0, n) as (offset + i * step) mod n. With gcd(step, n) = 1
    // every index is visited exactly once and no big array is needed.
    function permutation(n, seed) {
        const random = seededRandom(seed);
        let step = Math.max(1, Math.floor(random() * n));
        while (gcd(step, n) !== 1) step = (step + 1) % n || 1;
        const offset = Math.floor(random() * n);
        return (i) => (offset + i * step) % n;
    }

    const channelOffset = (channel) => Math.floor(channel / 3) * 4 + (channel % 3);

    function packHeader({ encrypted, length, salt, iv, crc }) {
        const header = new Uint8Array(HEADER_BYTES);
        header.set([0x56, 0x45, 0x49, 0x4c], 0); // VEIL
        header[4] = 1;
        header[5] = encrypted ? 1 : 0;
        new DataView(header.buffer).setUint32(6, length, false);
        if (encrypted) {
            header.set(salt, 10);
            header.set(iv, 26);
        }
        new DataView(header.buffer).setUint32(38, crc, false);
        return header;
    }

    function unpackHeader(data) {
        const header = new Uint8Array(HEADER_BYTES);
        for (let i = 0; i < HEADER_BITS; i++) {
            const value = data[channelOffset(i)];
            header[i >> 3] |= (value & 1) << (7 - (i & 7));
        }
        const magic = String.fromCharCode(header[0], header[1], header[2], header[3]);
        if (magic !== "VEIL") return null;
        const view = new DataView(header.buffer);
        return {
            version: header[4],
            encrypted: Boolean(header[5] & 1),
            length: view.getUint32(6, false),
            salt: header.slice(10, 26),
            iv: header.slice(26, 38),
            crc: view.getUint32(38, false),
        };
    }

    function writePayload(data, header, payload, seed) {
        for (let i = 0; i < HEADER_BITS; i++) {
            const index = channelOffset(i);
            data[index] = (data[index] & 0xfe) | ((header[i >> 3] >> (7 - (i & 7))) & 1);
        }
        const usable = data.length / 4 * 3 - HEADER_BITS;
        const position = permutation(usable, seed);
        for (let i = 0; i < payload.length * 8; i++) {
            const index = channelOffset(HEADER_BITS + position(i));
            data[index] = (data[index] & 0xfe) | ((payload[i >> 3] >> (7 - (i & 7))) & 1);
        }
    }

    function readPayload(data, info) {
        const usable = data.length / 4 * 3 - HEADER_BITS;
        const seed = info.encrypted ? seedFrom(info.salt) : seedFrom([0x76, 0x65, 0x69, 0x6c]);
        const position = permutation(usable, seed);
        const payload = new Uint8Array(info.length);
        for (let i = 0; i < info.length * 8; i++) {
            const value = data[channelOffset(HEADER_BITS + position(i))];
            payload[i >> 3] |= (value & 1) << (7 - (i & 7));
        }
        return payload;
    }

    async function deriveKey(passphrase, salt) {
        const base = await crypto.subtle.importKey(
            "raw",
            new TextEncoder().encode(passphrase),
            "PBKDF2",
            false,
            ["deriveKey"],
        );
        return crypto.subtle.deriveKey(
            { name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" },
            base,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
        );
    }

    async function seal(message, passphrase) {
        const bytes = new TextEncoder().encode(message);
        if (!passphrase) return { payload: bytes, encrypted: false };
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await deriveKey(passphrase, salt);
        const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
        return { payload: cipher, encrypted: true, salt, iv };
    }

    async function open(payload, info, passphrase) {
        if (!info.encrypted) return new TextDecoder().decode(payload);
        if (!passphrase) throw new Error("This message is encrypted. Enter its passphrase.");
        const key = await deriveKey(passphrase, info.salt);
        try {
            const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: info.iv }, key, payload);
            return new TextDecoder().decode(plain);
        } catch {
            throw new Error("Wrong passphrase, or the image was modified.");
        }
    }

    /* ------------------------------ hide tab ------------------------------ */

    let coverCanvas = null;

    function capacityFor(canvas) {
        const channels = canvas.width * canvas.height * 3;
        return Math.max(0, Math.floor((channels - HEADER_BITS) / 8));
    }

    function updateCapacity() {
        const fill = $("capacityFill");
        const text = $("capacityText");
        const pct = $("capacityPct");
        if (!coverCanvas) {
            fill.style.width = "0%";
            text.textContent = "Load a cover to see capacity";
            pct.textContent = "";
            return;
        }
        const max = capacityFor(coverCanvas);
        const pass = $("passphrase").value;
        const bytes = new TextEncoder().encode($("secret").value).length + (pass ? 28 : 0);
        const ratio = max ? Math.min(1, bytes / max) : 0;
        fill.style.width = `${(ratio * 100).toFixed(1)}%`;
        text.textContent = `${bytes.toLocaleString()} / ${max.toLocaleString()} bytes`;
        pct.textContent = `${coverCanvas.width}×${coverCanvas.height}`;
        if (bytes > max) text.textContent += " — too large";
    }

    async function loadCover(file) {
        try {
            coverCanvas = await toCanvas(file);
            $("hidePreview").src = URL.createObjectURL(file);
            $("hidePreview").hidden = false;
            $("hideEmpty").hidden = true;
            $("hideBtn").disabled = false;
            setStatus($("hideStatus"), "");
            $("downloadLink").hidden = true;
            updateCapacity();
        } catch {
            setStatus($("hideStatus"), "That file is not an image this browser can read.", "error");
        }
    }

    async function hideMessage() {
        if (!coverCanvas) return;
        const message = $("secret").value;
        if (!message.trim()) {
            setStatus($("hideStatus"), "Write a message first.", "error");
            return;
        }
        $("hideBtn").disabled = true;
        $("downloadLink").hidden = true;
        setStatus($("hideStatus"), "Packing pixels…");

        try {
            const passphrase = $("passphrase").value;
            const sealed = await seal(message, passphrase);
            const max = capacityFor(coverCanvas);
            if (sealed.payload.length > max) {
                throw new Error(`The message is too large for this cover. ${sealed.payload.length} > ${max} bytes.`);
            }

            const source = coverCanvas.getContext("2d").getImageData(0, 0, coverCanvas.width, coverCanvas.height);
            const data = new Uint8ClampedArray(source.data);
            const header = packHeader({
                encrypted: sealed.encrypted,
                length: sealed.payload.length,
                salt: sealed.salt,
                iv: sealed.iv,
                crc: crc32(sealed.payload),
            });
            const seed = sealed.encrypted ? seedFrom(sealed.salt) : seedFrom([0x76, 0x65, 0x69, 0x6c]);
            writePayload(data, header, sealed.payload, seed);
            let changed = 0;
            for (let i = 0; i < data.length; i++) {
                if (i % 4 === 3) continue;
                if (data[i] !== source.data[i]) changed++;
            }

            const output = document.createElement("canvas");
            output.width = coverCanvas.width;
            output.height = coverCanvas.height;
            output.getContext("2d").putImageData(new ImageData(data, output.width, output.height), 0, 0);

            const blob = await canvasToBlob(output);
            const url = URL.createObjectURL(blob);
            $("hidePreview").src = url;
            $("hidePreview").hidden = false;
            $("hideEmpty").hidden = true;

            const link = $("downloadLink");
            link.href = url;
            link.download = `veil-${Date.now()}.png`;
            link.hidden = false;
            setStatus(
                $("hideStatus"),
                sealed.encrypted
                    ? "Hidden and encrypted. Share the PNG and the passphrase separately."
                    : "Hidden. Anyone can decode it — add a passphrase for secrecy.",
                "ok",
            );
            $("capacityPct").textContent = `changed ${changed.toLocaleString()} channels`;
        } catch (error) {
            setStatus($("hideStatus"), error.message || "Could not hide the message.", "error");
        } finally {
            $("hideBtn").disabled = false;
        }
    }

    /* ------------------------------ seek tab ------------------------------ */

    let seekCanvas = null;

    async function loadSeek(file) {
        try {
            seekCanvas = await toCanvas(file);
            $("seekPreview").src = URL.createObjectURL(file);
            $("seekPreview").hidden = false;
            $("seekEmpty").hidden = true;
            $("seekBtn").disabled = false;
            $("revealBox").hidden = true;
            setStatus($("seekStatus"), "");
        } catch {
            setStatus($("seekStatus"), "That file is not an image this browser can read.", "error");
        }
    }

    async function revealMessage() {
        if (!seekCanvas) return;
        $("seekBtn").disabled = true;
        setStatus($("seekStatus"), "Reading pixels…");
        try {
            const { data } = seekCanvas.getContext("2d").getImageData(0, 0, seekCanvas.width, seekCanvas.height);
            const info = unpackHeader(data);
            if (!info) throw new Error("No Veil header found. This image carries no message (or it was re-saved as JPEG).");
            if (info.version !== 1) throw new Error(`Unsupported Veil version ${info.version}.`);
            const max = Math.floor((data.length / 4 * 3 - HEADER_BITS) / 8);
            if (info.length < 1 || info.length > max) throw new Error("The header is damaged.");
            const payload = readPayload(data, info);
            if (crc32(payload) !== info.crc) throw new Error("Checksum mismatch: the image was re-encoded or edited.");
            const message = await open(payload, info, $("seekPass").value);
            $("revealed").textContent = message;
            $("revealBox").hidden = false;
            setStatus($("seekStatus"), info.encrypted ? "Decrypted with your passphrase." : "Decoded (not encrypted).", "ok");
        } catch (error) {
            setStatus($("seekStatus"), error.message || "Could not read the image.", "error");
        } finally {
            $("seekBtn").disabled = false;
        }
    }

    /* ----------------------------- fable mode ----------------------------- */

    let fableSvg = "";
    let fableSecret = "";
    let fableScheme = "";
    let fableObjectUrl = "";

    function parseLooseJson(text) {
        const start = text.indexOf("{");
        const end = text.lastIndexOf("}");
        if (start !== -1 && end > start) {
            try {
                return JSON.parse(text.slice(start, end + 1));
            } catch {
                /* fall through */
            }
        }
        return null;
    }

    async function fableHide() {
        const secret = $("fableSecret").value.trim();
        if (!secret) {
            setStatus($("fableStatus"), "Write a secret first.", "error");
            return;
        }
        if (!authKey) {
            openAuth();
            return;
        }
        $("fableHideBtn").disabled = true;
        setStatus($("fableStatus"), "One model is drawing a cover…");
        $("fableGuessBox").hidden = true;
        $("fableTruthBox").hidden = true;
        $("fableSeekBtn").disabled = true;

        try {
            const raw = await chat(
                [
                    {
                        role: "system",
                        content:
                            "You are a steganographer and illustrator. You draw one compact SVG illustration and hide a secret message inside its source. " +
                            "Use a scheme a careful reader could discover from the source alone: an acrostic in visible <text> labels, a message split across element ids, " +
                            "or data hidden in comments or coordinates. Never write the secret as plain visible text. Reply with JSON only.",
                    },
                    {
                        role: "user",
                        content:
                            `Secret to hide: ${JSON.stringify(secret)}\n\n` +
                            'Return exactly {"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\" viewBox=\\"0 0 512 512\\">...</svg>","scheme":"one sentence describing where the secret is encoded"}. ' +
                            "The SVG must be self-contained, use no external assets, scripts or fonts, and be under 12000 characters. Make it a real illustration, not a diagram of the secret.",
                    },
                ],
                { model: "mistral", maxTokens: 2400, temperature: 0.9 },
            );

            const parsed = parseLooseJson(raw);
            let svg = parsed?.svg || "";
            if (!svg) {
                const match = raw.match(/<svg[\s\S]*<\/svg>/i);
                svg = match ? match[0] : "";
            }
            if (!svg) throw new Error("The model did not return an SVG. Try again.");

            fableSvg = svg;
            fableSecret = secret;
            fableScheme = parsed?.scheme || "The model did not describe its scheme.";
            if (fableObjectUrl) URL.revokeObjectURL(fableObjectUrl);
            fableObjectUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
            $("fableFrame").src = fableObjectUrl;
            $("fableFrame").hidden = false;
            $("fableFrameEmpty").hidden = true;
            $("fableCode").textContent = svg;
            $("fableCodeWrap").hidden = false;
            $("fableSeekBtn").disabled = false;
            setStatus($("fableStatus"), "Hidden. Now hand the same source to a fresh model.", "ok");
        } catch (error) {
            setStatus($("fableStatus"), error.message || "Could not draw the cover.", "error");
        } finally {
            $("fableHideBtn").disabled = false;
        }
    }

    async function fableSeek() {
        if (!fableSvg) return;
        if (!authKey) {
            openAuth();
            return;
        }
        $("fableSeekBtn").disabled = true;
        setStatus($("fableStatus"), "A fresh model is reading the SVG…");
        try {
            const guess = await chat(
                [
                    {
                        role: "system",
                        content:
                            "You are given the source of an SVG illustration. It hides a message. Find it. " +
                            "Check acrostics in visible text, element ids, comments, metadata, coordinates and colour values. " +
                            "Answer in at most four sentences: state the hidden message if you found it, then how it was hidden. If you cannot find it, say so plainly.",
                    },
                    { role: "user", content: fableSvg },
                ],
                { maxTokens: 600, temperature: 0.2 },
            );
            $("fableGuess").innerHTML = renderRich(guess);
            $("fableGuessBox").hidden = false;
            const normalized = guess.toLowerCase().replace(/[^a-z0-9 ]/g, " ");
            const found = normalized.includes(fableSecret.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim());
            const scheme = fableScheme.replace(/[.\s]+$/, "");
            $("fableTruth").innerHTML = `${found ? "The seeker found it." : "The seeker missed it."} The hider's scheme: <b>${escapeHtml(scheme)}</b>. The secret was <b>${escapeHtml(fableSecret)}</b>.`;
            $("fableTruthBox").hidden = false;
            setStatus($("fableStatus"), found ? "Round over: found." : "Round over: hidden.", "ok");
        } catch (error) {
            setStatus($("fableStatus"), error.message || "The seeker failed.", "error");
        } finally {
            $("fableSeekBtn").disabled = false;
        }
    }

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    }

    function renderRich(value) {
        return escapeHtml(value)
            .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
            .replace(/`([^`]+)`/g, "<code>$1</code>");
    }

    /* ------------------------------ wiring ------------------------------ */

    function wireDrop(dropId, inputId, handler) {
        const drop = $(dropId);
        const input = $(inputId);
        drop.addEventListener("dragover", (event) => {
            event.preventDefault();
            drop.classList.add("is-over");
        });
        drop.addEventListener("dragleave", () => drop.classList.remove("is-over"));
        drop.addEventListener("drop", (event) => {
            event.preventDefault();
            drop.classList.remove("is-over");
            const file = event.dataTransfer?.files?.[0];
            if (file) handler(file);
        });
        input.addEventListener("change", () => {
            const file = input.files?.[0];
            if (file) handler(file);
        });
    }

    document.querySelectorAll(".tab").forEach((tab) => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t === tab));
            document.querySelectorAll(".panel").forEach((panel) => panel.classList.toggle("is-active", panel.id === `tab-${tab.dataset.tab}`));
        });
    });

    wireDrop("hideDrop", "hideFile", loadCover);
    wireDrop("seekDrop", "seekFile", loadSeek);

    $("secret").addEventListener("input", updateCapacity);
    $("passphrase").addEventListener("input", updateCapacity);
    $("hideBtn").addEventListener("click", hideMessage);
    $("seekBtn").addEventListener("click", revealMessage);

    $("copyReveal").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("revealed").textContent || "");
            $("copyReveal").textContent = "Copied";
            setTimeout(() => ($("copyReveal").textContent = "Copy"), 1200);
        } catch {
            /* clipboard may be blocked */
        }
    });

    $("rehideBtn").addEventListener("click", async () => {
        if (!seekCanvas) return;
        coverCanvas = seekCanvas;
        $("hidePreview").src = $("seekPreview").src;
        $("hidePreview").hidden = false;
        $("hideEmpty").hidden = true;
        $("hideBtn").disabled = false;
        document.querySelector('[data-tab="hide"]').click();
        updateCapacity();
        setStatus($("hideStatus"), "Loaded the revealed image as a new cover.");
    });

    $("coverBtn").addEventListener("click", async () => {
        const prompt = $("coverPrompt").value.trim();
        if (!prompt) {
            setStatus($("coverStatus"), "Describe the cover first.", "error");
            return;
        }
        if (!authKey) {
            openAuth();
            return;
        }
        $("coverBtn").disabled = true;
        setStatus($("coverStatus"), "Drawing with Pollinations…");
        try {
            const blob = await generateCover(prompt);
            coverCanvas = await toCanvas(blob);
            $("hidePreview").src = URL.createObjectURL(blob);
            $("hidePreview").hidden = false;
            $("hideEmpty").hidden = true;
            $("hideBtn").disabled = false;
            $("downloadLink").hidden = true;
            updateCapacity();
            setStatus($("coverStatus"), `Cover ready: ${coverCanvas.width}×${coverCanvas.height}.`, "ok");
        } catch (error) {
            setStatus($("coverStatus"), error.message || "Could not generate a cover.", "error");
        } finally {
            $("coverBtn").disabled = false;
        }
    });

    $("decoyBtn").addEventListener("click", async () => {
        if (!authKey) {
            openAuth();
            return;
        }
        const prompt = $("coverPrompt").value.trim() || "an ordinary photo";
        $("decoyBtn").disabled = true;
        setStatus($("decoyStatus"), "Writing…");
        try {
            const caption = await chat(
                [
                    {
                        role: "system",
                        content:
                            "Write one short, innocuous caption for a photo, like a social post. No quotation marks, no hashtags, at most 20 words. Never hint that anything is hidden.",
                    },
                    { role: "user", content: `The photo: ${prompt}` },
                ],
                { maxTokens: 200, temperature: 1 },
            );
            $("decoy").value = caption.replace(/^["']|["']$/g, "").trim();
            setStatus($("decoyStatus"), "Caption ready. It is not embedded in the PNG.", "ok");
        } catch (error) {
            setStatus($("decoyStatus"), error.message || "Could not write a caption.", "error");
        } finally {
            $("decoyBtn").disabled = false;
        }
    });

    $("copyDecoy").addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText($("decoy").value || "");
            $("copyDecoy").textContent = "Copied";
            setTimeout(() => ($("copyDecoy").textContent = "Copy"), 1200);
        } catch {
            /* clipboard may be blocked */
        }
    });

    $("connectBtn").addEventListener("click", () => {
        if (authKey) {
            if (confirm("Disconnect this tab from Pollinations?")) clearKey();
            return;
        }
        openAuth();
        startDeviceFlow();
    });
    $("authClose").addEventListener("click", closeAuth);
    $("authModal").addEventListener("click", (event) => {
        if (event.target === $("authModal")) closeAuth();
    });
    $("useKeyBtn").addEventListener("click", () => {
        const key = $("pasteKey").value.trim();
        if (!/^(sk|pk)_/.test(key)) {
            setStatus($("pasteStatus"), "That does not look like a Pollinations key.", "error");
            return;
        }
        setKey(key);
        setStatus($("pasteStatus"), "Key saved for this tab.", "ok");
        setTimeout(closeAuth, 600);
    });

    $("fableHideBtn").addEventListener("click", fableHide);
    $("fableSeekBtn").addEventListener("click", fableSeek);

    updateAuth();
    updateCapacity();
})();
