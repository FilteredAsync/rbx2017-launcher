"""Build the rbx2017 Android app from the 2017 Roblox app (2.299.137632).

The app talks to this server instead of Roblox, as "rbx2017" (package
com.rbx2017.client, so it installs next to the real Roblox app):

  - its base address is m.<domain> and its API calls go to api.<domain>
    (Webserver/node/lib/mobile.js; both names point at the VPS,
    tools/vps/setup-vps.sh)
  - the game engine's own Roblox addresses are swapped for the domain, and it
    trusts the server's script key (Server/rbxsig_private.pem), like the PC
    client; content/fonts/LoadingScript.lua is signed again with it
  - rbx2017://placeID=<id> links start a game in it (the website's Play
    buttons on Android phones)
  - no Roblox analytics or Crittercism crash reports

The APK is Roblox's app: share it privately, never on GitHub or the website.

Needs Java, apktool (https://apktool.org, its .jar), Android build-tools
(zipalign, apksigner; ANDROID_HOME) and openssl (Git for Windows has one).

    python tools/build-android-apk.py <roblox-2-299-137632.apk> --apktool <apktool.jar>
        [--domain rbx2017.com] [--out share/rbx2017-android.apk]

Signs with config/android-signing.pk8 and .crt, made on the first build.
Keep them: Android installs an update only when it has the same signature.
"""

import argparse
import base64
import glob
import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VERSION = '2.299.137632'
PACKAGE = 'com.rbx2017.client'
APP_NAME = 'rbx2017'
OBB = 'assets/main.1.com.roblox.client.obb'
SIGNED_SCRIPT = 'content/fonts/LoadingScript.lua'
ENGINE = 'lib/armeabi-v7a/libroblox.so'


def fail(message):
    sys.exit(f'build-android-apk: {message}')


def run(args, **kwargs):
    result = subprocess.run(args, capture_output=True, text=True, **kwargs)
    if result.returncode != 0:
        fail(f'{os.path.basename(args[0])} failed:\n{(result.stdout + result.stderr)[-2000:]}')
    return result.stdout


def tool(name):
    found = shutil.which(name)
    if not found:
        fail(f'{name} not found on PATH.')
    return found


def build_tools():
    home = os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or os.path.join(os.environ.get('LOCALAPPDATA', ''), 'Android', 'Sdk')
    versions = sorted(glob.glob(os.path.join(home, 'build-tools', '*')))
    if not versions:
        fail(f'no Android build-tools in {home} (sdkmanager "build-tools;35.0.0").')
    folder = versions[-1]
    zipalign = os.path.join(folder, 'zipalign.exe' if os.name == 'nt' else 'zipalign')
    apksigner = os.path.join(folder, 'apksigner.bat' if os.name == 'nt' else 'apksigner')
    for path in (zipalign, apksigner):
        if not os.path.exists(path):
            fail(f'{path} is missing.')
    return zipalign, apksigner


def openssl(*args, data=None):
    result = subprocess.run([tool('openssl'), *args], input=data, capture_output=True)
    if result.returncode != 0:
        fail(f'openssl {args[0]} failed: {result.stderr.decode(errors="replace")[-500:]}')
    return result.stdout


# --- the Java side (smali) -------------------------------------------------------------------

def replace_strings(src, pairs):
    """const-string values in every smali file: {old: new}, each must be found."""
    found = {old: 0 for old in pairs}
    pattern = re.compile(r'(const-string(?:/jumbo)? [vp]\d+, )"((?:[^"\\]|\\.)*)"')
    for path in glob.glob(os.path.join(src, 'smali*', '**', '*.smali'), recursive=True):
        with open(path, encoding='utf-8', newline='') as handle:
            text = handle.read()

        def swap(match):
            value = match.group(2)
            if value in pairs:
                found[value] += 1
                return f'{match.group(1)}"{pairs[value]}"'
            return match.group(0)

        changed = pattern.sub(swap, text)
        if changed != text:
            with open(path, 'w', encoding='utf-8', newline='') as handle:
                handle.write(changed)
    missing = [old for old, count in found.items() if count == 0]
    if missing:
        fail(f'not found in the app code: {missing} (is this {VERSION}?)')


def no_crittercism(src):
    """AppManager.c(Context) starts Crittercism (Apteligent): return at once."""
    path = os.path.join(src, 'smali', 'com', 'roblox', 'client', 'm', 'c.smali')
    with open(path, encoding='utf-8', newline='') as handle:
        text = handle.read()
    nl = '\r\n' if '\r\n' in text else '\n'
    head = f'.method public c(Landroid/content/Context;)V{nl}    .locals 2{nl}{nl}    .prologue{nl}'
    at = text.find(head)
    if at < 0 or 'Initialize Apteligent' not in text[at:at + 600]:
        fail('the Crittercism start-up was not where expected.')
    text = text[:at + len(head)] + f'    # rbx2017: no Crittercism (third-party crash reports){nl}    return-void{nl}{nl}' + text[at + len(head):]
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(text)


def manifest_and_name(src):
    path = os.path.join(src, 'AndroidManifest.xml')
    with open(path, encoding='utf-8', newline='') as handle:
        text = handle.read()
    for old, new in [
        ('package="com.roblox.client"', f'package="{PACKAGE}"'),
        ('"com.roblox.client.permission.C2D_MESSAGE"', f'"{PACKAGE}.permission.C2D_MESSAGE"'),
        ('android:authorities="com.roblox.client.firebaseinitprovider"', f'android:authorities="{PACKAGE}.firebaseinitprovider"'),
        ('android:name="com.roblox.client.gcm"', f'android:name="{PACKAGE}.gcm"'),
        ('android:scheme="robloxmobile"', 'android:scheme="rbx2017"'),
    ]:
        if old not in text:
            fail(f'{old} is not in the manifest.')
        text = text.replace(old, new)
    with open(path, 'w', encoding='utf-8', newline='') as handle:
        handle.write(text)
    # The app's name on the home screen (android:label="@string/RobloxWord").
    for strings in glob.glob(os.path.join(src, 'res', 'values*', 'strings.xml')):
        with open(strings, encoding='utf-8', newline='') as handle:
            text = handle.read()
        changed = re.sub(r'(<string name="RobloxWord">)[^<]*(</string>)', rf'\g<1>{APP_NAME}\g<2>', text)
        if changed != text:
            with open(strings, 'w', encoding='utf-8', newline='') as handle:
                handle.write(changed)


# --- the game engine (libroblox.so) ------------------------------------------------------------

def patch_cstring(data, old, new):
    """Every zero-terminated string equal to old -> new, padded with zeros."""
    old_b, new_b = old.encode(), new.encode()
    if len(new_b) > len(old_b):
        fail(f'"{new}" is longer than "{old}" ({len(new_b)} > {len(old_b)}): pick a shorter domain.')
    count = 0
    at = data.find(old_b)
    while at >= 0:
        end = at + len(old_b)
        if (at == 0 or data[at - 1] == 0) and end < len(data) and data[end] == 0:
            data[at:end] = new_b + b'\0' * (len(old_b) - len(new_b))
            count += 1
        at = data.find(old_b, end)
    if count == 0:
        fail(f'"{old}" is not in the game engine (is this {VERSION}?)')


def patch_engine(src, domain, public_pem):
    path = os.path.join(src, ENGINE)
    with open(path, 'rb') as handle:
        data = bytearray(handle.read())
    # The key it checks signed scripts with (join scripts): the server's.
    at = data.find(b'-----BEGIN PUBLIC KEY-----\nMIGf')
    end = data.find(b'-----END PUBLIC KEY-----', at)
    if at < 0 or end < 0:
        fail('the engine\'s script key was not found.')
    old_key = bytes(data[at:end + len(b'-----END PUBLIC KEY-----')])
    new_key = public_pem.strip()
    if len(new_key) != len(old_key):
        fail('Server/rbxsig_private.pem is not a 1024-bit RSA key like the engine\'s.')
    data[at:at + len(new_key)] = new_key
    tail = lambda width: domain[-width:]
    for old, new in [
        ('http://www.roblox.com', f'http://m.{domain}'),
        ('http://www.roblox.com/Asset?id=%s', f'http://m.{domain}/Asset?id=%s'),
        ('assetgame.roblox.com', f'm.{domain}'),
        ('%s://%sapi.roblox.com/%s/?apiKey=%s', f'%s://%sapi.{domain}/%s?apiKey=%s'),
        ('http://test.public.ecs.roblox.com/', f'http://m.{domain}/'),
        # Domain checks (which sites it trusts): a suffix of the domain where
        # the whole name does not fit.
        ('.roblox.com', f'.{domain}' if len(domain) < 11 else tail(11)),
        ('roblox.com', tail(10)),
        ('roblox.com/', f'{tail(10)}/'),
        ('robloxlabs.com', tail(14)),
        ('.robloxlabs.com', f'.{domain}' if len(domain) < 15 else tail(15)),
        ('.robloxlabs.com/', f'.{domain}/' if len(domain) < 15 else f'{tail(15)}/'),
    ]:
        patch_cstring(data, old, new)
    with open(path, 'wb') as handle:
        handle.write(bytes(data))


def resign_loading_script(src, key_file):
    """The one signed script in its content, signed again with the server key."""
    path = os.path.join(src, OBB)
    with zipfile.ZipFile(path) as old:
        entries = [(info, old.read(info)) for info in old.infolist()]
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as new:
        for info, body in entries:
            if info.filename == SIGNED_SCRIPT:
                text = body.decode('latin1')
                if not text.startswith('--rbxsig%'):
                    fail(f'{SIGNED_SCRIPT} is not signed.')
                script = text[text.index('%', 9) + 1:]
                # The engine checks the signature over the script with CRLF line ends.
                signed_bytes = re.sub(r'\r?\n', '\r\n', script).encode('latin1')
                signature = openssl('dgst', '-sha1', '-sign', key_file, data=signed_bytes)
                body = f'--rbxsig%{base64.b64encode(signature).decode()}%{script}'.encode('latin1')
            new.writestr(info, body, compress_type=info.compress_type)
    with open(path, 'wb') as handle:
        handle.write(out.getvalue())


# --- building and signing --------------------------------------------------------------------

def signing_key():
    key = os.path.join(ROOT, 'config', 'android-signing.pk8')
    cert = os.path.join(ROOT, 'config', 'android-signing.crt')
    if not (os.path.exists(key) and os.path.exists(cert)):
        os.makedirs(os.path.dirname(key), exist_ok=True)
        with tempfile.TemporaryDirectory() as temp:
            pem = os.path.join(temp, 'key.pem')
            openssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', pem, '-out', cert,
                    '-days', '10000', '-subj', f'/CN={APP_NAME}')
            openssl('pkcs8', '-topk8', '-in', pem, '-outform', 'DER', '-nocrypt', '-out', key)
        print(f'Made the signing key: {os.path.relpath(key, ROOT)} and .crt (keep them for updates).')
    return key, cert


def main():
    parser = argparse.ArgumentParser(description='Build the rbx2017 Android app.')
    parser.add_argument('apk', help=f'the Roblox {VERSION} APK')
    parser.add_argument('--apktool', required=True, help='apktool .jar')
    parser.add_argument('--domain', default='rbx2017.com')
    parser.add_argument('--out', default=os.path.join(ROOT, 'share', 'rbx2017-android.apk'))
    args = parser.parse_args()
    domain = args.domain.lower().strip('.')
    if not re.fullmatch(r'[a-z0-9-]+(\.[a-z0-9-]+)+', domain):
        fail(f'{args.domain} is not a domain.')
    java = tool('java')
    zipalign, apksigner = build_tools()
    server_key = os.path.join(ROOT, 'Server', 'rbxsig_private.pem')
    if not os.path.exists(server_key):
        fail('Server/rbxsig_private.pem is missing (the server\'s script key).')
    public_pem = openssl('rsa', '-in', server_key, '-pubout').replace(b'\r\n', b'\n')
    key, cert = signing_key()

    with tempfile.TemporaryDirectory(prefix='rbx-apk-') as temp:
        src = os.path.join(temp, 'src')
        frameworks = os.path.join(temp, 'framework')
        print('Unpacking...')
        run([java, '-jar', args.apktool, 'd', '-f', '-p', frameworks, '-o', src, args.apk])
        with open(os.path.join(src, 'apktool.yml'), encoding='utf-8') as handle:
            if f'versionName: {VERSION}' not in handle.read():
                fail(f'this is not the {VERSION} app.')
        print(f'Patching for m.{domain} and api.{domain}...')
        replace_strings(src, {
            'www.roblox.com/': f'm.{domain}/',
            # More > Forum (hard-coded in RobloxSettings.forumUrl): our forums (lib/mobileforum.js).
            'https://www.roblox.com/Forum/default.aspx': f'https://m.{domain}/Forum/default.aspx',
            'https://ecsv2.roblox.com/pe.png?t=mobile&lt=': f'https://m.{domain}/pe.png?t=mobile&lt=',
            'https://ephemeralcounters.api.': 'https://api.',
            'https://clientsettings.api.': 'https://api.',
            'https://auth.': 'https://api.',
            'https://notifications.': 'https://api.',
            'robloxmobile://': 'rbx2017://',
            'robloxmobile://\\\\??(placeID=)?(\\\\d+)': 'rbx2017://\\\\??(placeID=)?(\\\\d+)',
        })
        no_crittercism(src)
        manifest_and_name(src)
        patch_engine(src, domain, public_pem)
        resign_loading_script(src, server_key)
        print('Building...')
        unsigned = os.path.join(temp, 'unsigned.apk')
        aligned = os.path.join(temp, 'aligned.apk')
        run([java, '-jar', args.apktool, 'b', '-p', frameworks, '-o', unsigned, src])
        run([zipalign, '-f', '-p', '4', unsigned, aligned])
        os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
        run([apksigner, 'sign', '--key', key, '--cert', cert, '--out', args.out, aligned], shell=os.name == 'nt')
        run([apksigner, 'verify', args.out], shell=os.name == 'nt')
    print(f'Done: {args.out} ({os.path.getsize(args.out) / 1e6:.1f} MB). Share it privately; never publish it.')


if __name__ == '__main__':
    main()
