#!/usr/bin/env bash
# VPS relay for the always-on server: players reach it over the internet with
# no Tailscale and no join code. This cloud server takes
#   - HTTPS on 443 (Caddy, with a free certificate) -> the server PC's web server
#   - UDP 53640-53659 (the game servers)             -> the server PC
# and forwards both over a WireGuard tunnel to the server PC (10.66.0.2; this
# VPS is 10.66.0.1). Only the server PC runs WireGuard; players run nothing.
#
# On a fresh Ubuntu 22.04/24.04 or Debian 12 VPS, as root:
#   bash setup-vps.sh                    set up (or update; keys are kept)
#   bash setup-vps.sh --domain NAME      use your own domain (its A record -> this VPS;
#                                        on Cloudflare, "DNS only", or UDP and the
#                                        certificate fail)
#   bash setup-vps.sh --site URL         send browsers opening the bare address
#                                        (https://NAME/ only) to the website, such
#                                        as https://www.rbx2017.com (site/README.md)
#   bash setup-vps.sh --android          also serve the Android app's names
#                                        (tools/build-android-apk.py): m, api,
#                                        assetgame, clientsettings.api and
#                                        ephemeralcounters.api .NAME; their A
#                                        records -> this VPS, "DNS only"
#   bash setup-vps.sh --check            is the server PC connected and answering?
# Without --domain the address is <ip-with-dashes>.sslip.io (a free DNS name
# that points at this IP), so no domain is needed. With one, that sslip.io
# name keeps working too: launchers not yet moved (POST /api/server/moved)
# and links already shared still reach the server.
#
# Then, on the server PC: install WireGuard for Windows, import the tunnel
# file this prints (/root/rbx-relay/server-pc.conf), activate it, run
# wireguardFirewall.bat, and restart the server (restartServer.bat).

set -euo pipefail

DOMAIN=""
SITE=""
ANDROID=0
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --site) SITE="${2:-}"; shift 2 ;;
    --android) ANDROID=1; shift ;;
    --check) CHECK=1; shift ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done
if [ -n "$SITE" ] && ! [[ "$SITE" =~ ^https://[A-Za-z0-9.-]+/?$ ]]; then
  echo "--site takes an address like https://www.example.com"; exit 1
fi
[ "$(id -u)" = 0 ] || { echo "Run this as root (sudo bash setup-vps.sh)."; exit 1; }

DIR=/root/rbx-relay
TUNNEL=wg-rbx
GAME_PORTS=53640:53659
PC=10.66.0.2

PUBIF=$(ip -4 route show default | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
[ -n "$PUBIF" ] || { echo "No default network interface found."; exit 1; }
PUBIP=$(ip -4 -o addr show dev "$PUBIF" scope global | awk '{print $4}' | cut -d/ -f1 | head -n1)
case "$PUBIP" in
  # Some providers put a private address on the interface: ask the internet.
  ""|10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) PUBIP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true) ;;
esac
[ -n "$PUBIP" ] || { echo "Could not find this VPS's public IPv4 address."; exit 1; }

SSLIP="$(echo "$PUBIP" | tr . -).sslip.io"
if [ -f "$DIR/domain" ] && [ -z "$DOMAIN" ]; then DOMAIN=$(cat "$DIR/domain"); fi
[ -n "$DOMAIN" ] || DOMAIN="$SSLIP"
DOMAIN=$(echo "$DOMAIN" | tr 'A-Z' 'a-z')
case "$DOMAIN" in *[!a-z0-9.-]*|"") echo "Not a domain name: $DOMAIN"; exit 1 ;; esac
# Caddy serves (and gets certificates for) both names.
SITES="$DOMAIN"
[ "$DOMAIN" = "$SSLIP" ] || SITES="$DOMAIN, $SSLIP"
# The Android app's names (Webserver/node/lib/mobile.js), kept on later runs.
# Also plain HTTP with no redirect: the 2017 engine asks some http:// addresses.
[ -f "$DIR/android" ] && ANDROID=1
# m and api are the app's; the game engine asks assetgame (PlaceLauncher),
# clientsettings.api (its flags) and ephemeralcounters.api.
ANDROID_NAMES="m api assetgame clientsettings.api ephemeralcounters.api"
ANDROID_SITES=""
if [ "$ANDROID" = 1 ]; then
  [ "$DOMAIN" != "$SSLIP" ] || { echo "--android needs --domain (m.NAME, api.NAME and others)."; exit 1; }
  for name in $ANDROID_NAMES; do ANDROID_SITES="${ANDROID_SITES:+$ANDROID_SITES, }$name.$DOMAIN, http://$name.$DOMAIN"; done
  for name in $ANDROID_NAMES; do
    getent ahostsv4 "$name.$DOMAIN" >/dev/null || echo "Note: $name.$DOMAIN has no A record yet (add it, DNS only, then run this again)."
  done
fi

if [ "$CHECK" = 1 ]; then
  echo "Address for players: https://$DOMAIN"
  if wg show "$TUNNEL" >/dev/null 2>&1; then
    last=$(wg show "$TUNNEL" latest-handshakes | awk '{print $2}' | head -n1)
    if [ -n "$last" ] && [ "$last" != 0 ]; then echo "Tunnel: last handshake $(( $(date +%s) - last )) s ago"; else echo "Tunnel: the server PC has not connected yet"; fi
  else
    echo "Tunnel: not running (systemctl status wg-quick@$TUNNEL)"
  fi
  if curl -fsS --max-time 8 "http://$PC/api/games" >/dev/null; then echo "Server PC web server: answering"; else echo "Server PC web server: no answer (tunnel down, firewall, or the server is not listening on $PC)"; fi
  if curl -fsS --max-time 15 "https://$DOMAIN/api/games" >/dev/null; then echo "Public address: working"; else echo "Public address: not working yet"; fi
  exit 0
fi

echo "== Installing WireGuard and Caddy"
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q wireguard iptables curl
if ! command -v caddy >/dev/null 2>&1 && ! apt-get install -y -q caddy; then
  # Not in this release's repositories (Ubuntu 22.04): Caddy's own.
  apt-get install -y -q debian-keyring debian-archive-keyring apt-transport-https gnupg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -q
  apt-get install -y -q caddy
fi

echo "== WireGuard tunnel ($TUNNEL)"
mkdir -p "$DIR" /etc/wireguard
chmod 700 "$DIR" /etc/wireguard
umask 077
[ -f "$DIR/vps.key" ] || wg genkey > "$DIR/vps.key"
[ -f "$DIR/server-pc.key" ] || wg genkey > "$DIR/server-pc.key"
echo "$DOMAIN" > "$DIR/domain"
if [ "$ANDROID" = 1 ]; then touch "$DIR/android"; fi
VPS_PUB=$(wg pubkey < "$DIR/vps.key")
PC_PUB=$(wg pubkey < "$DIR/server-pc.key")

# Game traffic: arriving UDP goes to the server PC; its source becomes this
# end of the tunnel, so the replies come back the same way.
RULES="-t nat -A PREROUTING -i $PUBIF -p udp --dport $GAME_PORTS -j DNAT --to-destination $PC
-t nat -A POSTROUTING -o $TUNNEL -p udp -d $PC --dport $GAME_PORTS -j MASQUERADE
-I FORWARD -i $PUBIF -o $TUNNEL -p udp -d $PC --dport $GAME_PORTS -j ACCEPT
-I FORWARD -i $TUNNEL -o $PUBIF -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT"
{
  echo "[Interface]"
  echo "Address = 10.66.0.1/24"
  echo "ListenPort = 51820"
  echo "PrivateKey = $(cat "$DIR/vps.key")"
  echo "PostUp = sysctl -q -w net.ipv4.ip_forward=1"
  while IFS= read -r rule; do echo "PostUp = iptables $rule"; done <<< "$RULES"
  while IFS= read -r rule; do echo "PostDown = iptables $(echo "$rule" | sed -e 's/ -A / -D /' -e 's/^-I /-D /')"; done <<< "$RULES"
  echo
  echo "[Peer]"
  echo "# the server PC"
  echo "PublicKey = $PC_PUB"
  echo "AllowedIPs = $PC/32"
} > "/etc/wireguard/$TUNNEL.conf"
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/99-rbx-relay.conf
sysctl -q -p /etc/sysctl.d/99-rbx-relay.conf
systemctl enable "wg-quick@$TUNNEL" >/dev/null 2>&1
systemctl restart "wg-quick@$TUNNEL"

echo "== Firewall"
if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 51820/udp >/dev/null
  ufw allow "$GAME_PORTS/udp" >/dev/null
  ufw route allow proto udp to "$PC" port "$GAME_PORTS" >/dev/null
  echo "ufw: opened 80, 443, 51820/udp and $GAME_PORTS/udp"
else
  echo "ufw is not on. If your provider has a cloud firewall, open TCP 80, 443 and UDP 51820, $GAME_PORTS there."
fi

echo "== Caddy (HTTPS for $SITES${ANDROID_SITES:+, and the Android names})"
[ -f /etc/caddy/Caddyfile ] && [ ! -f /etc/caddy/Caddyfile.before-rbx ] && cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-rbx
SITE_REDIRECT=""
[ -n "$SITE" ] && SITE_REDIRECT=$'\t# The bare address in a browser opens the website (site/).\n\tredir / '"$SITE"$' 302\n'
ANDROID_BLOCK=""
[ -n "$ANDROID_SITES" ] && ANDROID_BLOCK=$'
# The Android app.
'"$ANDROID_SITES"$' {
	import rbx_server
}
'
cat > /etc/caddy/Caddyfile <<CADDY
# The VPS relay for the always-on server (setup-vps.sh).
(rbx_server) {
	request_body {
		max_size 1GB
	}
	reverse_proxy $PC:80 {
		# The launcher's own forwarded host goes through unchanged (Studio
		# builds its links from it); the public name and the player's
		# address come along for the server (lib/publicnet.js).
		header_up X-Forwarded-Host {http.request.header.X-Forwarded-Host}
		header_up X-Rbx-Public-Host {host}
		flush_interval -1
		transport http {
			dial_timeout 10s
		}
	}
}

$SITES {
${SITE_REDIRECT}	import rbx_server
}
${ANDROID_BLOCK}

http://$PUBIP {
	redir https://$DOMAIN{uri}
}
CADDY
systemctl enable caddy >/dev/null 2>&1
systemctl restart caddy

cat > "$DIR/server-pc.conf" <<WG
[Interface]
PrivateKey = $(cat "$DIR/server-pc.key")
Address = $PC/24

[Peer]
PublicKey = $VPS_PUB
Endpoint = $PUBIP:51820
AllowedIPs = 10.66.0.1/32
PersistentKeepalive = 25
WG

echo
echo "Done. Address for players: https://$DOMAIN"
echo
echo "Tunnel file for the server PC (keep it private; it is also in $DIR/server-pc.conf):"
echo "----------------------------------------------------------------------"
cat "$DIR/server-pc.conf"
echo "----------------------------------------------------------------------"
echo "On the server PC: install WireGuard (wireguard.com/install), Import tunnel(s) from file,"
echo "Activate, run wireguardFirewall.bat, then restartServer.bat. Check with: bash setup-vps.sh --check"
