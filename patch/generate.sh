#!/usr/bin/env sh
cd ./vyos-1x && find . -type f -exec diff -u "../../vyos-build/build/vyos-1x/{}" "{}" \; > ../vyos-1x.patch && cd ..
cd ./vyos-build && find . -type f -exec diff -u "../../vyos-build/{}" "{}" \; > ../vyos-build.patch && cd ..
