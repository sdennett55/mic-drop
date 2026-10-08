# MicDrop Soundboard

MicDrop is a Windows desktop soundboard for mixing downloaded audio clips with a physical headset microphone and sending the combined signal to games as one microphone input.

## Install

Download `MicDrop-Setup-1.2.0.exe` from the latest GitHub release and follow the setup wizard. The current installer is not code-signed, so Windows SmartScreen may ask you to confirm that you want to run it.

## What it does

- Imports MP3, WAV, OGG, M4A, AAC, and FLAC files by file picker or drag and drop into a persistent library.
- Mixes the physical microphone and soundboard clips in real time.
- Sends the mix to a selectable Windows playback device.
- Sends a separate clips-only monitor feed to your headphones so you hear every triggered sound without hearing your own microphone echoed back.
- Detects suspended or reset Windows audio sessions and reconnects the microphone and selected outputs automatically.
- Selects VB-CABLE when first configuring the mixed output and starts the audio engine automatically on launch.
- Opens an always-on-top sound picker with a global shortcut.
- Supports individual global shortcuts for every sound.
- Includes per-clip and master volume controls, microphone gain, muting, search, and routing guidance.

## Audio setup

Windows needs a virtual audio device to expose an application's output as a microphone. No additional physical hardware is required.

1. Leave **Install VB-CABLE** selected in MicDrop Setup, then restart Windows. If it was skipped, install it from the [official VB-CABLE page](https://vb-audio.com/Cable/).
2. In MicDrop's **Audio routing** screen:
   - Select the physical headset/USB microphone as **Microphone input**.
   - Select **CABLE Input** as **Mixed audio output**.
   - Select the headphones as **Hear clips through** and leave monitoring on.
   - Start the audio engine and turn on microphone passthrough.
3. In Steam Voice or the game's settings, select **CABLE Output** as the voice input device.
4. Use **Borderless Windowed** mode if an exclusive-fullscreen game hides the overlay.

The official VB-CABLE Driver Pack 45 is bundled unchanged with the Windows installer. VB-CABLE is separate donationware from VB-Audio Software, remains subject to [VB-Audio's license](https://vb-audio.com/Services/licensing.htm), and is not removed when MicDrop is uninstalled.

## Development

Requires Node.js 22.12 or newer on Windows.

```powershell
npm ci
npm start
```

Build the x64 Windows installer:

```powershell
npm run dist
```

If the official VB-CABLE archive is not already cached locally, the build downloads it directly from VB-Audio. Its pinned SHA-256 checksum is verified before packaging. The downloaded archive and completed installer remain untracked, and the installer is written to `dist/MicDrop-Setup-1.2.0.exe`.

Run the same syntax checks used by continuous integration:

```powershell
npm run check
```

## Notes

- The microphone is muted on first launch to prevent feedback when the output still points to normal speakers.
- MicDrop must remain running for global shortcuts and audio routing to work. It can be minimized while playing.
- Imported files are copied into the application's user-data directory, so moving the original files does not break the library.

## License

MicDrop's source code is available under the [MIT License](LICENSE). VB-CABLE is separate software owned by VB-Audio Software and is distributed under its own terms; see the [third-party notice](third_party/VB-CABLE-NOTICE.txt).
