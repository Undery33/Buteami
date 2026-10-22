# Backend 실행과 배포 준비

이 문서의 운영 명령은 담당자가 설정과 변경 사항을 검토한 뒤 별도 변경 작업에서 실행하기 위한 것이다. 인증 DB/Secrets/API 리소스와 실제 HTTPS 프록시 설정의 운영 반영은 별도 확인이 필요하다. Jenkinsfile은 기존 상태를 유지한다. 루트 웹 Dockerfile은 기존 HTTPS 설정을 교체하지 않는 `/api/` include 파일만 이미지에 추가한다. 파일 복사만으로 프록시가 활성화되지는 않는다.

## 먼저 확인할 운영 조건

현재 알려진 NodePort는 `http://192.168.10.110:31991`이며 사용자가 확인한 HTTPS origin은 `https://www.buteami.com`이다. 운영 ConfigMap의 `APP_ORIGIN`은 이 도메인으로 설정한다. 사용자가 제공한 Pod의 `nginx -T` 출력에는 기본 `listen 80`, `listen [::]:80`, `server_name localhost`만 있고 Pod 내부 TLS 설정은 없다. HTTPS는 이 Pod 외부에서 종료되지만 정확한 앞단 장비와 라우팅 위치는 아직 확인되지 않았다. 사설 인증서를 사용하는 HTTPS 접근에는 테스트 브라우저의 올바른 CA 신뢰가 필요하며 실제 인증서 체인/도메인을 확인한다. HTTP NodePort에 직접 접속하면 운영용 Secure 인증 쿠키가 전달되지 않는다. 개발 모드의 `COOKIE_SECURE=false`는 격리된 로컬 테스트용이다.

운영 HTTP 접속은 HTTPS로 리디렉션하도록 구성해야 한다. 계정 화면은 원격 HTTP에서 입력과 모든 계정 API 요청을 차단하고 HTTPS 주소를 안내한다. HTTP 예외는 격리된 로컬 테스트의 정확한 루프백 호스트 `localhost`, `127.0.0.1`, `[::1]`뿐이며 사설 네트워크 IP에는 적용되지 않는다.

사용자가 제공한 운영 `users` DDL은 InnoDB, `utf8mb4_general_ci`, `id VARCHAR(50)` 기본키, 이메일 unique 인덱스, `name VARCHAR(100)`, nullable `birthday DATE`다. 스키마 검사와 additive migration은 이 기존 정의를 기준으로 검토하며 `users`의 크기·collation·nullable 정의를 임의로 변경하지 않는다. 실제 서버에 적용된 최신 DDL과 기존 비밀번호 해시 형식, DB 접속 권한/허용 호스트, 노드/Pod에서 `192.168.20.10:3306`으로의 경로는 별도 검증이 필요하다.

현재 SMTP 계정은 없으며 `ad.buteami.com`에는 AD만 구성되어 있고 Exchange/SMTP 서비스는 없다. AD 도메인 주소만으로 인증·복구 이메일을 보낼 수 없으므로 별도 SMTP 서비스/relay의 접속 정보, 발신 주소, TLS와 인증 방식을 준비해야 한다. 이 작업에서 `k8s_master@192.168.10.110`에 대한 BatchMode SSH 연결은 `Permission denied (publickey,password)`로 실패했다. 따라서 직접 서버 접속으로 운영 DB·프록시·메일 상태를 검증하지 못했다. 방화벽·DB 사용자 권한·DNS·TLS를 임의로 변경하지 않는다.

SE 작업은 사용자가 직접 진행한다. 아래 명령과 설정은 실행 방법을 제공하며 이미지 발행·Secret 생성·클러스터 적용을 자동 실행하지 않는다. 기존 Git 태그 `1.0.0`은 이전 커밋에 그대로 두며 후속 보안·정책 변경을 포함하도록 이동하지 않는다. 이번 수정은 최신 `main`을 기준으로 빌드한다.

## 격리된 로컬 전체 실행

Docker Compose 사용 환경에서 다음 순서로 실행한다. 이 스택은 컨테이너 `db`의 MariaDB 10.11과 `buteami_test` DB에만 연결한다. 운영 DB 환경변수를 `.env`에 넣었더라도 Compose가 로컬 DB 설정으로 덮어쓴다.

1. `backend/.env.example`을 `backend/.env`로 복사한다.
2. 파일 편집기로 `APP_SECRET`, `LOCAL_DB_PASSWORD`, `LOCAL_DB_ROOT_PASSWORD`를 각각 새로 생성한 값으로 채운다. 실제 운영 비밀번호를 재사용하지 않는다.
3. `backend` 디렉터리에서 실행한다.

```sh
docker compose --profile app up --build
```

웹: `http://localhost:8080`, 테스트 메일함: `http://localhost:8025`. 웹 포트를 변경했다면 같은 값이 `APP_ORIGIN`에 반영되도록 `LOCAL_WEB_PORT`를 변경한다. API와 SMTP 포트는 호스트에 공개하지 않는다. MariaDB는 로컬 진단용 `127.0.0.1:13306`에만 연결한다.

회원가입 → 메일함에서 인증 토큰 복사 → 이메일 인증 → 로그인 → 잘못된 비밀번호 3회로 잠금 → 재설정 요청 → 메일 토큰을 이용한 새 비밀번호 설정 → 이전 세션이 더 이상 유효하지 않은지 확인한다. 메일함에는 가짜 계정/주소만 사용한다.

```sh
# 전용 DB 통합 테스트. 기존 app 스택이 실행 중이면 먼저 종료한다.
docker compose down
docker compose --profile test run --build --rm tests
docker compose down
```

통합 테스트는 테스트용 행/테이블을 변경할 수 있다. 다른 용도의 DB에 실행하지 않는다. `down`은 로컬 데이터 볼륨을 보존한다. 빈 DB에서 다시 검증하려면 볼륨의 테스트 데이터가 모두 삭제되어도 되는지 확인한 뒤 이 Compose 프로젝트의 `local_db` 볼륨만 명시적으로 정리한다. 기존 11.8 개발 DB 볼륨을 10.11에 직접 연결하지 않는다.

## Node에서 실행

Node.js 24와 npm이 있는 환경에서 루트 `npm test`, `backend`의 `npm ci`와 `npm test`를 실행한다. 실제 실행 전 `.env`의 DB 대상이 의도한 테스트 대상인지 반드시 확인한다.

```sh
cd backend
npm ci
npm test
# DB를 처음 구성할 때만 명시적으로 실행. 운영에서는 별도 migration 계정 사용.
npm run migrate
npm run check-schema
npm start
```

호스트 Node와 로컬 Compose DB를 함께 쓴다면 `.env`에 `DB_HOST=127.0.0.1`, `DB_PORT=13306`, `DB_NAME=buteami_test`, `DB_USER=buteami_test`, `DB_PASSWORD`는 `LOCAL_DB_PASSWORD`와 같은 값으로 설정한다. 위 명령을 운영 주소가 남은 기본 템플릿으로 실행하지 않는다.

## 컨테이너와 Kubernetes 파일

| 파일 | 용도 |
| --- | --- |
| `backend/Dockerfile` | Node 24 API, 비root 사용자, production 의존성만 설치 |
| `deployment/web.Dockerfile` | 로컬/검토용 Nginx 프록시 이미지 |
| `deployment/k8s/api-config.yaml` | 공개 가능한 설정. HTTPS origin/SMTP 값을 검토 후 교체 |
| `deployment/k8s/api.yaml` | API Deployment/ClusterIP/서비스 계정, Secret 참조, probe, 자원 제한 |
| `deployment/k8s/migration-job.yaml` | 별도 계정으로 명시적으로 실행하는 마이그레이션 Job |
| `deployment/nginx/api-location.conf` | 기존 Nginx server block 안에 운영자가 포함할 `/api/` location |
| `deployment/nginx/default.conf.template`, `15-buteami-resolver.envsh` | 로컬/별도 HTTP upstream용 전체 server 설정과 실제 DNS resolver 탐색 |
| `deployment/k8s/nginx-integration.patch.yaml` | 별도 HTTP upstream인 경우에만 검토할 전략적 병합 패치. 기존 TLS 설정을 대체하는 용도로 사용 금지 |
| `deployment/kustomization.yaml` | API 리소스와 Nginx ConfigMap 렌더링. Job/기존 웹 패치는 제외 |

API 이미지는 Docker가 있는 빌드 환경에서 최신 `main`을 기준으로 별도 빌드·발행한다. 기존 Jenkins는 웹만 배포하므로 API 이미지는 자동으로 생성되지 않는다. 아래 이미지 이름은 알아보기 쉬운 `:main`을 사용하며, 이후 같은 태그를 갱신할 수 있으므로 실제 운영 리소스에는 발행 결과의 digest를 고정한다. 클러스터 적용은 사용자가 별도로 진행한다.

```sh
docker build -t ghcr.io/undery33/buteami-api:main backend
docker login ghcr.io -u Undery33
docker push ghcr.io/undery33/buteami-api:main
docker image inspect ghcr.io/undery33/buteami-api:main --format '{{index .RepoDigests 0}}'
# API가 없는 상태에서도 웹 시작/정적 화면 제공 여부를 검토하는 로컬 이미지
docker build -f deployment/web.Dockerfile -t buteami-web:review .
# 실제 변경 없이 manifest 렌더링
kubectl kustomize deployment
```

`docker login`의 비밀번호 프롬프트에는 GHCR 권한이 있는 GitHub 토큰을 입력하고 명령 인자·채팅에 토큰을 넣지 않는다. 배포 전 `api.yaml`과 `migration-job.yaml`의 이미지 참조를 위 명령으로 확인한 같은 digest로 교체한다. Git의 기록용 태그 `1.0.0`만으로 이미지가 자동 생성되지는 않는다. 비공개 registry라면 클러스터 운영 기준에 맞는 `imagePullSecrets`도 별도로 연결한다. 기존 웹의 pull 성공만으로 새 API 패키지 권한을 단정하지 않는다. 매니페스트의 기본 2 replicas와 자원 제한은 부하 테스트/운영 용량 확인 전의 시작값이다.

## Secret과 DB 권한

추적되는 Secret YAML이나 기본 비밀번호는 제공하지 않는다. 운영 비밀 저장소 또는 접근이 제한된 Git 외부 파일을 사용해 아래 Secret을 준비한다. `--from-literal=비밀번호`처럼 명령줄에 비밀번호를 넣지 않는다. 생성 결과 YAML을 Issue/PR/CI 로그에 출력하지 않는다.

| Secret 이름 | 필요한 key |
| --- | --- |
| `buteami-api-secrets` | `DB_PASSWORD`, `APP_SECRET`, `SMTP_USER`, `SMTP_PASSWORD` |
| `buteami-migration-secrets` | `DB_USER`, `DB_PASSWORD` |
| `buteami-db-ca` (선택) | `ca.crt` |

SMTP 인증을 사용하지 않는 사내 relay라면 `SMTP_USER`/`SMTP_PASSWORD` key는 공백 값으로 준비하고 relay 접근 제어와 TLS를 별도로 검토한다. 운영의 SMTP 587은 STARTTLS, 465는 `SMTP_SECURE=true` 설정을 사용한다.

선택한 네이버 SMTP를 쓰려면 네이버 ID의 2단계 인증을 설정하고, 메일 환경설정에서 POP3/SMTP 사용을 켠 뒤 애플리케이션 비밀번호를 생성한다. 설정 이름은 `Buteami API`처럼 알아보기 쉽게 지정한다. ConfigMap에는 `SMTP_HOST=smtp.naver.com`, `SMTP_PORT=587`, `SMTP_SECURE=false`, 본인 발신 주소를 설정한다. 운영 모드는 STARTTLS를 필수로 요구한다. Secret의 `SMTP_USER`에는 네이버 SMTP 계정, `SMTP_PASSWORD`에는 일반 로그인 비밀번호 대신 앱 비밀번호를 넣는다. 비밀번호는 채팅에 보내지 않는다. [네이버 SMTP 설정](https://help.naver.com/service/30029/contents/21351?osType=COMMONOS), [앱 비밀번호 정책](https://help.naver.com/service/30029/contents/24347?lang=ko&osType=COMMONOS).

Secret은 Git 외부의 권한 600 파일을 편집기로 작성한 뒤 `kubectl -n default create secret generic buteami-api-secrets --from-env-file=/비공개경로/api-secrets.env` 형태로 생성한다. 파일에는 표의 네 key를 사용하며 실제 값을 명령줄에 쓰거나 파일을 `source`하지 않는다. migration Secret도 별도 파일의 `DB_USER`, `DB_PASSWORD`로 같은 방식으로 생성한다. 이미 존재하는 Secret을 무조건 교체하지 않는다.

`DB_TLS_CA_FILE`을 사용할 때는 신뢰할 CA만 `buteami-db-ca`에 넣고 ConfigMap 값을 `/etc/buteami/db-ca/ca.crt`로 지정한다. 현재 mysql2의 호스트 검증을 확실히 적용하기 위해 이 모드의 `DB_HOST`는 인증서 SAN과 일치하는 DNS 이름이어야 한다. IP 주소와 CA 파일을 함께 지정하면 앱이 시작을 거부한다. 인증서 검증을 끄는 방식으로 해결하지 않는다. 기본 IP 연결은 DB TLS 활성화를 의미하지 않는다.

DB 운영자는 DDL을 백업/검토하고 migration 계정에 해당 DB의 CREATE와 필요한 조회 권한을 준비한다. 앱 계정은 인증 테이블과 `users`에 대한 SELECT/INSERT/UPDATE/DELETE만 필요하다. 운영 DB 계정에 전역 권한, GRANT OPTION, DROP/ALTER 권한을 추가하지 않는다. 계정 host 제한은 실제 연결이 나타나는 Pod/노드 주소를 확인해 정한다.

`npm run migrate`는 기존 DDL을 검사한 뒤 `CREATE TABLE IF NOT EXISTS`만 수행한다. MariaDB DDL은 트랜잭션 rollback으로 되돌릴 수 있다고 가정하지 않는다. 호환되지 않는 테이블에서는 중단하고 원인을 검토한다. `npm run check-schema`는 테이블/인덱스 호환성을 검사하며 누락된 테이블을 생성하지 않는다. API는 운영 시작 시 마이그레이션을 자동 실행하지 않는다.

## 운영자가 별도 승인 후 진행할 순서

1. 제공된 DDL과 실제 서버 정의가 같은지, 해시/권한, 외부 TLS 종료와 HTTPS origin, SMTP 전달, Pod → DB 경로를 읽기/테스트 환경에서 확인한다. 백업과 롤백 계획을 준비한다.
2. placeholder를 교체하고 Secret을 준비한 뒤 `kubectl kustomize deployment` 결과를 검토한다. 운영에 필요한 NetworkPolicy가 있다면 실제 Nginx 라벨, DNS, DB와 SMTP egress 범위를 확인해 추가한다.
3. 별도 migration 계정으로 스키마 사전 검사와 additive migration을 실행한다. Job은 한 번만 명시적으로 실행하며 기존 실행 결과를 확인하지 않고 반복 생성하지 않는다.
4. API 리소스를 반영하고 readiness/로그/실제 SMTP를 확인한다. DB나 스키마가 준비되지 않으면 API는 준비 상태가 되지 않아야 한다.
5. 외부 HTTPS 앞단과 인증서·라우팅을 보존할 수 있는지 확인한 뒤, 확인된 Pod의 HTTP server block에 `include /etc/nginx/buteami/api-location.conf;`를 추가하거나 검토된 HTTP upstream template를 사용한다. include 방식은 같은 server/http 문맥에 실제 Pod `/etc/resolv.conf`의 nameserver를 사용한 `resolver 실제_DNS주소 valid=10s ipv6=off;`도 있어야 한다. `nginx -t`와 롤백 설정을 확인한 뒤 운영 절차로 반영한다. 기존 NodePort Service나 `31991`은 변경하지 않는다.
6. HTTPS 웹 origin으로 가입/인증/로그인/잠금/재설정 흐름을 확인한다. 기존 CI는 웹 이미지만 갱신하므로 API 배포는 운영자가 별도로 관리한다.

제공된 `nginx -T` 출력으로 Pod 내부가 기본 HTTP 서버라는 점은 확인됐지만 외부 TLS 종료 위치와 전체 마운트·라우팅은 아직 확인되지 않았다. 외부 TLS를 보존하고 해당 Pod가 HTTP upstream 역할을 계속 제공하는 것을 먼저 확인한 뒤에만 `nginx-integration.patch.yaml`의 전체 HTTP template 적용을 검토한다. 이후 운영 설정에 HTTPS server block이 추가됐다면 이를 HTTP template로 덮어쓰면 안 된다. 이 파일은 **완전한 Deployment가 아니며** 운영자 적용 형식은 `kubectl -n default patch deployment nginx --type strategic --patch-file deployment/k8s/nginx-integration.patch.yaml`이다. ConfigMap 파일은 `subPath`로 마운트되어 후속 수정 시 Nginx Pod 재시작이 필요하다.

로컬/HTTP upstream template는 `/etc/resolv.conf`에서 DNS 주소를 읽고 API 이름을 요청 시점에 해석한다. HTTPS include 방식을 사용할 때는 위와 같이 운영자가 실제 resolver를 설정한다. API Service가 아직 없어도 Nginx가 시작되며 `/api/` 요청은 502가 된다. 프록시는 요청 URI를 보존하므로 `/api/auth/...` 접두사를 제거하지 않는다. 내부 대상은 `buteami-api:3000` ClusterIP Service다. 관련 동작은 [Nginx 프록시 문서](https://nginx.org/en/docs/http/ngx_http_proxy_module.html)와 [공식 이미지 envsubst 구현](https://github.com/nginx/docker-nginx/blob/master/stable/debian/20-envsubst-on-templates.sh)을 기준으로 작성했다.

웹 롤백은 저장해 둔 기존 Deployment/config로 돌리는 별도 운영 변경이다. API 롤백은 이전 검토 이미지로 전환하고 호환성을 확인한다. 새 인증 테이블이나 기존 `users` 데이터를 자동 삭제하는 down migration은 제공하지 않는다.

## 실제 검증 범위

개발 실행 환경에는 Docker와 kubectl이 없어 이미지 빌드, Docker Compose 실행, manifest의 Kubernetes 서버 검증, 기존 웹과 운영 DB 연결은 여기서 수행하지 않았다. 별도로 격리된 native MariaDB를 이용한 검증은 Docker 검증과 구분해 PR에 기록한다. YAML 7개 파일은 파서로 문법을 확인했으며 Kubernetes API/Compose 의미 검증을 대신하지 않는다. `.github/workflows/backend.yml`은 격리된 MariaDB 10.11에서 migration/스키마/통합 테스트와 API/웹 이미지 빌드, API DNS가 없는 상태의 웹 시작 검증을 실행하도록 구성한다. 워크플로가 추가됐다는 이유만으로 통과했다고 기록하지 않는다.

실제 실행한 단위/통합 테스트 수, CI 상태와 commit, 운영 DDL/네트워크/SMTP 미검증 여부는 PR 검증 기록에 별도로 남긴다. 준비된 매니페스트와 운영 배포 성공을 구분한다.
