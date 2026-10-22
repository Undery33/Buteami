# 인증 Backend

기존 정적 HTML/JavaScript 화면과 Nginx 배포 구조를 유지하고, Node.js 24의 ES modules, Express, mysql2, Nodemailer로 인증 API를 추가한다. API는 MariaDB를 직접 사용하며 별도 ORM이나 외부 인증 서비스를 요구하지 않는다. 운영 배포는 이 PR에 포함되지 않는다. 배포 준비와 검증 범위는 [배포 안내](backend-deployment.md)를 따른다.

## 사용자 흐름과 API

브라우저는 Nginx와 같은 origin의 `/api/`로 요청한다. 변경 요청은 JSON과 `X-Buteami-Request: 1`을 보내며 서버가 정확한 `APP_ORIGIN`도 검사한다. 인증 상태는 HttpOnly 쿠키로 유지한다. 토큰을 URL, 브라우저 저장소 또는 화면 로그에 넣지 않는다.

| 경로 | 입력 | 결과 |
| --- | --- | --- |
| `POST /api/auth/signup` | `username`, `fullName`, `birthday`, `email`, `password`, `confirmPassword` | 202 일반 안내, 등록 이메일로 본인 인증 토큰 발송 |
| `POST /api/auth/verify-email` | `token` | 본인 인증 뒤 계정 활성화 |
| `POST /api/auth/resend-verification` | `username`, `email` | 202 일반 안내, 조건이 맞으면 인증 메일 재발송 |
| `POST /api/auth/login` | `username`, `password` | 인증 쿠키와 `user: {username, fullName}` |
| `GET /api/auth/me` | 인증 쿠키 | 현재 사용자 정보 |
| `POST /api/auth/logout` | 빈 JSON 객체 | 서버 세션과 쿠키 해제 |
| `POST /api/auth/request-password-reset` | `username`, `email` | 202 일반 안내, 조건이 맞으면 재설정 토큰 발송 |
| `POST /api/auth/reset-password` | `token`, `password`, `confirmPassword` | 새 비밀번호 저장, 잠금/실패 횟수 해제, 기존 세션 무효화 |
| `POST /api/auth/find-id` | `fullName`, `email` | 202 일반 안내, 조건이 맞으면 이메일로 아이디 안내 |
| `GET /api/health/live` | 없음 | 프로세스 생존 확인 |
| `GET /api/health/ready` | 없음 | DB 및 인증 스키마 준비 확인 |

회원가입 직후에는 이메일 인증이 필요하다. 메일의 토큰을 인증 화면에 직접 붙여 넣는다. 이메일 인증 토큰은 30분, 비밀번호 재설정 토큰은 15분 유효하며 한 번만 사용할 수 있다. 계정 존재 여부를 확인할 수 있는 가입·복구·아이디 찾기 응답에는 실제 계정 정보나 토큰을 반환하지 않는다.

동일 계정의 비밀번호가 연속 3회 틀리면 계정을 잠근다. 이름·생년월일·아이디 같은 공개 가능한 정보만으로 잠금을 해제하거나 새 비밀번호를 설정할 수 없다. 등록한 이메일의 재설정 토큰으로 본인 인증을 마쳐야 한다.

## DB 연결과 기존 데이터

운영 연결 대상은 요청받은 `192.168.20.10:3306`, DB `buteami_db`, 애플리케이션 계정 `buteami_app`이다. 이 주소가 개발/테스트 명령으로 자동 사용되면 안 된다. Compose와 CI는 별도의 `buteami_test` DB를 사용한다.

| 기존 `users` 열 | 의미 |
| --- | --- |
| `id` | 회원번호를 추가 생성하지 않고 UI의 아이디를 저장 |
| `password_hash` | 솔트가 있는 비밀번호 해시 |
| `birthday` | 생년월일 DATE |
| `email`, `name` | 이메일과 이름 |
| `account_active` | 이메일 인증 여부 |
| `failed_login_attempts`, `account_locked` | 로그인 실패 횟수와 계정 잠금 |
| `created_at` | 생성 시각 |

`001-auth.sql`은 `users`가 없을 때 생성하고, 가입 대기 표시·인증 세션·일회용 토큰·요청 제한·메일 outbox 테이블을 추가한다. 기존 `users`의 열, 해시, 행을 변경하거나 삭제하지 않는다. 기존 `users`의 실제 DDL과 인덱스가 호환되지 않으면 스키마 사전 검사에서 중단한다. 운영 `SHOW CREATE TABLE users`, 기존 비밀번호 해시 형식, DB 권한은 실제 서버에서 아직 확인하지 않았다. 오류를 피하려고 자동으로 `ALTER`하거나 샘플 데이터를 삽입하면 안 된다.

인증 보조 테이블의 `user_id`에 FK를 강제하지 않는다. 계정과 토큰 처리는 트랜잭션에서 확인하며 `users.id`는 인증 테이블과 같은 `utf8mb4_unicode_ci` collation이어야 한다. 호환되지 않는 기존 테이블을 자동 변환하지 않는다. 가입 대기 표시가 있는 신규 계정만 이메일 인증으로 활성화할 수 있어 관리자가 비활성화한 기존 계정을 인증 메일 재발송으로 되살리지 않는다. 임의의 SQL 클라이언트로 `users`를 삭제하는 기능은 제공하지 않는다.

## 보안 및 운영 특성

- 비밀번호는 Node의 scrypt와 사용자별 솔트로 해시한다. 원문 비밀번호를 DB, 로그, 이메일에 저장하지 않는다.
- SQL 값은 mysql2의 파라미터 바인딩으로 전달한다. 로그인 실패 횟수와 잠금 전환은 같은 계정에 대한 트랜잭션/행 잠금 안에서 처리해 동시 요청으로 횟수가 유실되지 않게 한다.
- 세션/일회용 토큰은 충분한 난수로 생성하고 DB에는 해시를 저장한다. 재설정 완료 시 이전 세션을 취소한다.
- 메일 내용은 `APP_SECRET`에서 유도한 키로 암호화해 outbox에 저장한다. 요청 처리를 메일 전달 성공 여부와 분리하고 각 API 인스턴스의 worker가 lease를 획득해 최대 5회 전달을 시도한다. SMTP 장애가 있으면 인증 메일이 도착하지 않을 수 있으므로 outbox의 지연·재시도 상태를 운영에서 확인해야 한다. 재시도가 끝난 메일을 원문으로 덤프하지 말고 SMTP 원인을 해결한 뒤 사용자가 새 인증 코드를 요청하도록 안내한다.
- 요청 제한 상태도 DB에 저장해 여러 API 인스턴스에 공유한다. `TRUST_PROXY_CIDRS`는 기본 공백이며 확인된 프록시 범위만 허용한다. Nginx는 외부가 보낸 `X-Forwarded-For`를 그대로 신뢰하지 않는다.
- 운영 모드는 HTTPS `APP_ORIGIN`과 `COOKIE_SECURE=true`를 요구한다. `DB_TLS_CA_FILE`을 지정하면 CA와 서버 인증서를 검증한다. 운영 SMTP는 TLS/STARTTLS를 사용한다.
- 앱은 DB 스키마를 자동 수정하지 않는다. 마이그레이션은 별도 DB 계정으로 실행하고 앱 계정에는 필요한 테이블의 조회·삽입·수정·삭제 권한만 부여한다.

`APP_SECRET`은 최소 32바이트의 무작위 비밀이며 모든 인스턴스에 동일하게 제공한다. 기존 outbox가 남은 상태에서 임의로 교체하면 암호화된 메일을 복호화하지 못하므로, 교체 전에 기존 메일 처리를 마치고 세션·토큰 영향을 검토한다. DB 비밀번호, SMTP 자격증명, 토큰을 Git, 명령 인자, PR/Issue에 넣지 않는다.

## 테스트

저장소 루트 `npm test`는 UI 계약을 검증한다. `backend`의 `npm test`는 인증 정책·검증·HTTP 동작을 검증하며, `npm run test:integration`은 `DB_TEST_ENABLED=1`을 명시한 전용 테스트 DB에서 MariaDB 트랜잭션·동시 요청·스키마/토큰 처리를 검증한다. 상세 실행 명령은 [배포 안내](backend-deployment.md)에 있다.

자동화 파일이 추가되었다는 사실과 실제 실행 성공은 구분해야 한다. 검증 결과와 미검증 범위는 PR 본문에 기록하며, 이 문서는 운영 연결·메일 전달·컨테이너 배포가 완료됐다는 증거가 아니다.
