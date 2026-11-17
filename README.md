git fetch tv-upstream
git subtree pull --prefix=tv-api tv-upstream main --squash

git fetch vela-upstream
git subtree pull --prefix=vela vela-upstream main --squash

git fetch chan-upstream
git subtree pull --prefix=chan.py chan-upstream main --squash
