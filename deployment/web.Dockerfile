# Optional local/review image. The existing root Dockerfile/Jenkins stay intact.
FROM nginx:stable-alpine
ENV NGINX_ENVSUBST_FILTER="^(NGINX_RESOLVER|BUTEAMI_API_UPSTREAM)$"
ARG VCS_REF=local
ARG BUILD_NUMBER=local
COPY index.html /usr/share/nginx/html/index.html
COPY assets/ /usr/share/nginx/html/assets/
COPY auth/ /usr/share/nginx/html/auth/
RUN printf '{"release":"web-2026.10.20","commit":"%s","build":"%s"}\n' \
    "$VCS_REF" "$BUILD_NUMBER" > /usr/share/nginx/html/version.json
COPY deployment/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deployment/nginx/15-buteami-resolver.envsh /docker-entrypoint.d/15-buteami-resolver.envsh
RUN chmod 0555 /docker-entrypoint.d/15-buteami-resolver.envsh
EXPOSE 80
