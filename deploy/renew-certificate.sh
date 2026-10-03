#!/usr/bin/env bash
# Certbot вызывает этот hook после обновления сертификата. Реагируем только на наш домен.
set -euo pipefail
case " ${RENEWED_DOMAINS:-} " in
    *' max-api.komaroff-dev.ru '*)
        nginx -t
        systemctl reload nginx
        ;;
esac
