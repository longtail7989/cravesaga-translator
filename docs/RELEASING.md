# 릴리스 운영

## 준비
1. `manifest.json`과 `core.mjs`의 버전을 일치시킵니다.
2. `node scripts/test.mjs`로 오프라인 회귀 검증을 실행합니다. 실제 로그인·제공자 번역 요청은 하지 않습니다.
3. `node scripts/build-extension.mjs --out dist --tag v0.3.5`와 `node scripts/build-helper.mjs --out dist --offline --tag v0.3.5`로 각각 빌드합니다. 버전은 해당 릴리스에 맞춥니다.
4. 설정·토큰·프로필·개인 캐시·게임 원문 수집 파일이 Git 변경 목록에 없는지 확인합니다. 빌드는 허용 목록과 검증된 공개 의존성 아카이브만 사용합니다.

## 게시
```sh
git add .
git commit -m "Release v0.3.5"
git push origin main
git tag v0.3.5
git push origin v0.3.5
```

태그는 manifest/core 버전과 정확히 일치해야 합니다. GitHub Actions가 오프라인 검증, 확장 ZIP 재현성 확인, helper 빌드, SHA256SUMS 생성을 마쳐야 GitHub Release를 게시합니다. 확장 ZIP·Windows helper ZIP·체크섬이 함께 올라갑니다.

실패 시 Actions 로그를 확인하고 수정본은 새 버전/태그로 릴리스하는 것을 기본으로 합니다. 이미 내려받은 ZIP의 버전과 태그를 임의로 덮어 바꾸지 마세요. 동일 태그의 실패한 업로드만 재시도하려면 Actions → Release extension and Windows helper → Run workflow에서 **기존 태그**를 입력합니다. 자동화는 없는 태그를 임의로 만들지 않습니다.

## 권한·배포 범위
검증 작업은 contents:read, 게시 작업만 contents:write를 사용합니다. GitHub 기본 GITHUB_TOKEN을 사용하므로 별도 PAT나 저장소 Secret을 등록할 필요가 없습니다. GitHub Releases 배포이며 Chrome 웹 스토어 게시·서명·자동 업데이트는 포함하지 않습니다.

helper는 unsigned Windows x64·외부 Node 필요·고정 확장 ID 신뢰 제한이 있습니다. 원본 SDK 비상업용 라이선스·제3자 고지를 보존해야 하며, 배포가 ChatGPT 모델 이용 권한을 부여하지 않습니다. 상세 설치 조건은 `chatgpt-helper/README.md`를 확인하세요.
