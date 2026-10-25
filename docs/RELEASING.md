# 릴리스 운영

이 저장소는 확장 ZIP 하나와 `SHA256SUMS`만 배포합니다. helper는 [별도 저장소](https://github.com/longtail7989/cravesage-translator-gpt-helper)와 [별도 릴리스](https://github.com/longtail7989/cravesage-translator-gpt-helper/releases/latest)에서 관리합니다. 확장 CI·릴리스에는 helper 소스·빌드·테스트가 필요하지 않습니다.

## 준비
1. 새 확장 릴리스가 필요할 때만 `manifest.json`과 `core.mjs`의 버전을 함께 변경합니다. helper 저장소 분리만으로 버전을 올리거나 새 확장 릴리스를 만들지 않습니다.
2. `node scripts/test.mjs`로 확장 전용 오프라인 CJS suite 22개(독립 실행 20개 + worker에 포함된 2개)를 검증합니다. native-client mock은 유지하며 실제 로그인·제공자 번역 요청·별도 helper 테스트는 하지 않습니다.
3. `node scripts/build-extension.mjs --out dist --tag v0.3.5`로 확장만 빌드합니다. 예시 버전은 실제 새 릴리스에 맞춥니다. Node.js 22.13 이상을 사용하며 Actions는 Windows·PowerShell 7에서 실행합니다.
4. 설정·토큰·프로필·개인 캐시·게임 원문 수집 파일이 Git 변경 목록에 없는지 확인합니다. 확장 빌드는 명시적인 파일 허용 목록만 사용합니다.

## 향후 새 확장 릴리스 게시
```sh
git add .
git commit -m "Release vX.Y.Z"
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

`X.Y.Z`는 새 manifest/core 버전으로 바꾸며, 태그는 그 버전과 정확히 일치해야 합니다. GitHub Actions가 오프라인 검증, 확장 ZIP 재현성 확인, 단일 항목 SHA256SUMS 생성을 마쳐야 GitHub Release를 게시합니다. 업로드 대상은 `crave-ai-translator-X.Y.Z-extension.zip` 하나와 `SHA256SUMS`입니다. helper ZIP은 포함하지 않습니다.

실패 시 Actions 로그를 확인하고 수정본은 새 버전/태그로 릴리스하는 것을 기본으로 합니다. 이미 배포한 ZIP, 커밋 기록, 기존 태그를 덮어쓰거나 옮기지 마세요. 동일 태그의 실패한 업로드만 재시도하려면 Actions → **Release extension** → Run workflow에서 **기존 태그**를 입력합니다. 자동화는 없는 태그를 만들지 않으며, 이미 있는 파일은 다운로드해 SHA256이 일치하는지 검증하고 없는 파일만 추가합니다. 기존 파일과 내용이 다르면 덮어쓰지 않고 실패합니다.

과거 태그는 당시 소스와 워크플로를 그대로 가리킵니다. helper 분리를 적용하려고 v0.3.5 태그를 다시 만들거나 예전 릴리스 워크플로를 실행하지 마세요. 기존 v0.3.5 확장 ZIP은 그대로 보존합니다. 분리 안내와 helper 자산 이동은 별도 helper 릴리스 검증 후 릴리스 메타데이터 정리로 처리하며, 이 문서나 워크플로 변경 자체는 그 작업을 실행하지 않습니다. 설치된 확장·로그인 정보·실행 중인 게임도 변경하지 않습니다.

## 권한·배포 범위
검증 작업은 contents:read, 게시 작업만 contents:write를 사용합니다. GitHub 기본 GITHUB_TOKEN을 사용하므로 별도 PAT나 저장소 Secret을 등록할 필요가 없습니다. GitHub Releases 배포이며 Chrome 웹 스토어 게시·서명·자동 업데이트는 포함하지 않습니다.

helper는 unsigned Windows x64·외부 Node 필요·고정 확장 ID 신뢰 제한이 있습니다. SDK 비상업용 라이선스·제3자 고지와 상세 설치 조건은 [helper 설치 안내](https://github.com/longtail7989/cravesage-translator-gpt-helper#readme)를 확인하세요. helper 배포가 ChatGPT 모델 이용 권한을 부여하지 않습니다.
