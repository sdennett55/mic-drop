const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const archiveName = 'VBCABLE_Driver_Pack45.zip';
const archiveDirectory = path.join(__dirname, '..', 'build', 'vendor');
const archivePath = path.join(archiveDirectory, archiveName);
const temporaryPath = `${archivePath}.download`;
const downloadUrl = `https://download.vb-audio.com/Download_CABLE/${archiveName}`;
const expectedSha256 = 'b950e39f01af1d04ea623c8f6d8eb9b6ea5c477c637295fabf20631c85116bfb';

function sha256(contents) {
  return crypto.createHash('sha256').update(contents).digest('hex');
}

function verify(contents) {
  const actualSha256 = sha256(contents);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `VB-CABLE archive checksum mismatch.\nExpected: ${expectedSha256}\nActual:   ${actualSha256}`,
    );
  }
}

async function prepareArchive() {
  if (fs.existsSync(archivePath)) {
    verify(fs.readFileSync(archivePath));
    console.log(`Verified cached official VB-CABLE Pack 45 (${expectedSha256}).`);
    return;
  }

  console.log(`Downloading official VB-CABLE Pack 45 from ${downloadUrl}`);
  const response = await fetch(downloadUrl, {
    redirect: 'follow',
    headers: { 'User-Agent': 'MicDrop-build/1.2.0' },
  });

  if (!response.ok) {
    throw new Error(`VB-CABLE download failed with HTTP ${response.status}.`);
  }

  const contents = Buffer.from(await response.arrayBuffer());
  verify(contents);

  fs.mkdirSync(archiveDirectory, { recursive: true });
  fs.writeFileSync(temporaryPath, contents, { flag: 'wx' });
  fs.renameSync(temporaryPath, archivePath);
  console.log(`Downloaded and verified official VB-CABLE Pack 45 (${expectedSha256}).`);
}

prepareArchive().catch((error) => {
  if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath);
  console.error(error.message);
  process.exitCode = 1;
});
