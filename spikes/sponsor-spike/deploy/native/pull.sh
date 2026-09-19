#!/bin/bash
# pull.sh <repo> <tag> <dest> — fetch an amd64 image's layers via the Docker Hub registry API (no docker needed)
set -e
repo=$1; tag=$2; dest=$3; mkdir -p $dest/rootfs
tok=$(curl -s "https://auth.docker.io/token?service=registry.docker.io&scope=repository:$repo:pull" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])')
ACC="application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json"
man=$(curl -s -H "Authorization: Bearer $tok" -H "Accept: $ACC" "https://registry-1.docker.io/v2/$repo/manifests/$tag")
digest=$(echo "$man" | python3 -c '
import sys,json; m=json.load(sys.stdin)
if "manifests" in m:
    for x in m["manifests"]:
        p=x.get("platform",{})
        if p.get("architecture")=="amd64" and p.get("os")=="linux": print(x["digest"]); break
else: print("")')
[ -n "$digest" ] && man=$(curl -s -H "Authorization: Bearer $tok" -H "Accept: $ACC" "https://registry-1.docker.io/v2/$repo/manifests/$digest")
echo "$man" > $dest/manifest.json
blob() { # follow redirect manually so the bearer token is not forwarded to the CDN
  loc=$(curl -s -o /dev/null -w '%{redirect_url}' -H "Authorization: Bearer $tok" "https://registry-1.docker.io/v2/$repo/blobs/$1")
  if [ -n "$loc" ]; then curl -s -L "$loc"; else curl -s -H "Authorization: Bearer $tok" "https://registry-1.docker.io/v2/$repo/blobs/$1"; fi
}
cfg=$(echo "$man" | python3 -c 'import sys,json;print(json.load(sys.stdin)["config"]["digest"])')
blob $cfg > $dest/config.json
for l in $(echo "$man" | python3 -c 'import sys,json;[print(x["digest"]) for x in json.load(sys.stdin)["layers"]]'); do
  blob $l > $dest/layer.tgz; python3 "$(dirname "$0")/extract.py" $dest/layer.tgz $dest/rootfs; rm $dest/layer.tgz
done
python3 -c '
import json;c=json.load(open("'$dest'/config.json"))["config"]
print("== '$repo:$tag' ==");print("Entrypoint:",c.get("Entrypoint"));print("Cmd:",c.get("Cmd"));print("WorkingDir:",c.get("WorkingDir"),"User:",c.get("User"));print("Env:",c.get("Env"))'
