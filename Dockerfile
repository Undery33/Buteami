FROM nginx:stable-alpine

ARG VCS_REF=local
ARG BUILD_NUMBER=local

COPY index.html /usr/share/nginx/html/index.html
COPY assets/ /usr/share/nginx/html/assets/
COPY auth/ /usr/share/nginx/html/auth/

COPY deployment/nginx/api-location.conf /etc/nginx/buteami/api-location.conf

RUN printf '{"release":"web-2026.10.20","commit":"%s","build":"%s"}\n' \
    "$VCS_REF" "$BUILD_NUMBER" > /usr/share/nginx/html/version.json

EXPOSE 80
