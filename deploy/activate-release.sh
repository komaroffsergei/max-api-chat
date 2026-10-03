#!/usr/bin/env bash
# Скрипт запускается на VPS. Архив уже собран локально и загружен в /tmp.
# Пример: bash activate-release.sh /tmp/max-api-build.tar.gz SHA256 20261002-commit
set -euo pipefail

archive=${1:?Укажите архив сборки}
expected_sha=${2:?Укажите SHA-256 архива}
release_id=${3:?Укажите версию релиза}
base=/srv/portfolio/max-api

[[ "$archive" == /tmp/max-api-*.tar.gz ]] || { echo 'Неожиданный путь архива' >&2; exit 1; }
[[ "$expected_sha" =~ ^[a-fA-F0-9]{64}$ ]] || { echo 'Неверный SHA-256' >&2; exit 1; }
[[ "$release_id" =~ ^[a-zA-Z0-9][a-zA-Z0-9-]{1,79}$ ]] || { echo 'Неверная версия' >&2; exit 1; }
release="$base/releases/$release_id"
test ! -e "$release"
test -d "$base/releases"

printf '%s  %s\n' "$expected_sha" "$archive" | sha256sum -c -

# Проверяем имена до распаковки. Архив не должен писать за пределами нового релиза.
python3 - "$archive" <<'PY'
import pathlib
import sys
import tarfile

with tarfile.open(sys.argv[1], 'r:gz') as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not (member.isfile() or member.isdir()):
            raise SystemExit('Небезопасная запись внутри архива')
PY

mkdir "$release"
tar -xzf "$archive" -C "$release" --no-same-owner
test -f "$release/index.html"
test -f "$release/release.json"

# current может быть только symlink: обычный каталог здесь не перезаписываем.
if [[ -e "$base/current" && ! -L "$base/current" ]]; then
    echo 'current оказался обычным каталогом, переключение отменено' >&2
    exit 1
fi
previous=$(readlink "$base/current" || true)
sudo -n nginx -t
ln -sfn "$release" "$base/current.next"
mv -Tf "$base/current.next" "$base/current"

# При ошибке проверки возвращаем предыдущую ссылку. Сами релизы не удаляем.
rollback() {
    if [[ -n "$previous" ]]; then
        ln -sfn "$previous" "$base/current.next"
        mv -Tf "$base/current.next" "$base/current"
    else
        unlink "$base/current"
    fi
}

# Проверяем свой Nginx с настоящим hostname и TLS, без зависимости от DNS-кеша VPS.
# Доступность домена снаружи проверяется отдельно после переключения.
if ! curl --fail --silent --show-error --max-time 15 \
    --resolve 'max-api.komaroff-dev.ru:443:127.0.0.1' \
    "https://max-api.komaroff-dev.ru/release.json?verify=$release_id" \
    | python3 -c 'import json,sys; assert json.load(sys.stdin)["releaseId"] == sys.argv[1]' "$release_id"; then
    rollback
    echo 'Проверка опубликованной версии не прошла, выполнен откат' >&2
    exit 1
fi

if [[ -n "$previous" ]]; then
    ln -sfn "$previous" "$base/previous"
fi
printf 'RELEASE_OK %s\n' "$release_id"
