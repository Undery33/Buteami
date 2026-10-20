# 부티미(Buteami)

부산IT아카데미 **(클라우드운영관리) 클라우드를 활용한 인프라 구축 엔지니어-A** 과정의 온프레미스 인프라 구축 팀 프로젝트입니다.

## 웹 GUI

- 참고 이미지의 검은 배경, 보라·핑크 조명, 중앙 제목과 세로 타임라인을 적용한 반응형 소개 페이지
- 프로젝트 소개, 인프라 구성 탭, 기술 분류 필터, CI/CD 과정, 팀 역할 소개
- 모바일 메뉴, 키보드 탭 이동, 본문 바로가기, 동작 줄이기 설정 지원
- 외부 폰트/CDN 없이 저장소 내 HTML·CSS·JavaScript·이미지만 사용
- 문서에 기록된 설계·계획과 실제 저장소 배포 설정을 구분해 표시

## 파일과 로컬 확인

`index.html`이 실제 서비스 진입점이며 `assets/`에 CSS, JavaScript, 로고와 파비콘이 있습니다. 기존 `html/index.html`은 배포 대상이 아닙니다.

이 폴더에서 `python -m http.server 8080 --bind 127.0.0.1`을 실행하고 `http://127.0.0.1:8080/`을 엽니다. 별도의 패키지 설치나 프런트엔드 빌드가 필요하지 않습니다.

## 배포와 증거 확인

1. 개발 PC의 `feature/web`에서 수정 및 커밋합니다.
2. `feature/web → main` PR에 변경 사항과 검증 결과를 기록하고 병합합니다.
3. Jenkins는 `H/5 * * * *` 주기로 변경을 확인합니다.
4. rootless BuildKit이 NGINX 이미지를 빌드하고 GHCR에 저장합니다.
5. Kubernetes의 `deployment/nginx` 이미지를 갱신하고 롤아웃 결과를 확인합니다.
6. 본사 내 PC 브라우저에서 `http://www.buteami.com/`을 확인합니다.

빌드 시 `GIT_COMMIT`과 `BUILD_NUMBER`를 Docker build argument로 전달합니다. 이미지에 생성된 `/version.json`과 페이지 하단의 배포 버전 링크를 PR의 병합 커밋과 비교하면, 어떤 코드가 배포되었는지 확인할 수 있습니다. 로컬 `version.json`은 개발용이며 이미지에서는 빌드 정보로 생성합니다. 이 정보는 배포 출처이며 실시간 서비스 상태를 뜻하지 않습니다.

운영 서버 파일을 직접 수정하지 않고 Git과 CI/CD를 통해 반영합니다. 배포가 실패하면 Jenkins의 Checkout, Build and Push, Deploy to Kubernetes 단계 로그를 확인합니다. 롤백도 되돌림 커밋을 `feature/web`의 새 PR로 병합해 수행합니다.

## 콘텐츠와 로고 출처

- 사용자 제공 프로젝트 계획서, 주제 선정 및 구성도 회의록, 조별 작업일지(2026년 10월 자료)
- 본 저장소의 `Dockerfile`, `Jenkinsfile`: 현재 배포 설정의 기준. 계획서의 Docker Hub 대신 실제 설정의 GHCR로 안내합니다.
- [부산IT아카데미 공식 홈페이지](https://btc.ac.kr/)
- [공식 로고 원본](https://btc.ac.kr/data/menu/LOGO_YQ7YXIKJ02q1MEFvWVbd1749781334.png), 2026-10-20 확인

공식 로고 원본은 투명 PNG이며 `assets/busan-it-academy.png`에 보관합니다. 별도 배경 제거는 필요하지 않았고, 어두운 화면에서는 CSS로 단색 표시합니다. 학교 로고의 권리는 해당 교육기관에 있습니다. 본 사이트는 교육과정 팀 프로젝트 소개이며 교육기관 공식 홈페이지가 아닙니다.

내부 IP, 계정, 비밀번호, 원본 프로젝트 문서는 웹 자산에 포함하지 않습니다. Prometheus·Grafana·LibreNMS는 프로젝트 계획 범위로 안내하며, 실시간 가동 상태나 검증되지 않은 성능 수치를 표시하지 않습니다.
