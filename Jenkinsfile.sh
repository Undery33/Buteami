
pipeline {
    agent {
        kubernetes {
            cloud 'kubernetes'
            yaml '''
apiVersion: v1
kind: Pod
spec:
  serviceAccountName: ci-deployer
  securityContext:
    runAsUser: 1000
    runAsGroup: 1000
    fsGroup: 1000
  containers:
    - name: buildkit
      image: moby/buildkit:rootless
      command: ["sh", "-c"]
      args: ["sleep 99d"]
      env:
        - name: BUILDKITD_FLAGS
          value: --oci-worker-no-process-sandbox
      securityContext:
        runAsUser: 1000
        runAsGroup: 1000
        seccompProfile:
          type: Unconfined
        appArmorProfile:
          type: Unconfined
      volumeMounts:
        - name: buildkit-data
          mountPath: /home/user/.local/share/buildkit

    - name: kubectl
      image: alpine/k8s:1.37.1
      command: ["sh", "-c"]
      args: ["sleep 99d"]

  volumes:
    - name: buildkit-data
      emptyDir: {}
'''
        }
    }

    options {
        skipDefaultCheckout(true)
        disableConcurrentBuilds()
    }

    triggers {
        pollSCM('H/5 * * * *')
    }

    environment {
        IMAGE_REPO = 'ghcr.io/undery33/k8s-web-demo'
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Prepare') {
            steps {
                script {
                    env.IMAGE_REF = "${env.IMAGE_REPO}:build-${env.BUILD_NUMBER}"
                }
                echo "Target image: ${env.IMAGE_REF}"
            }
        }

        stage('Build and Push') {
            steps {
                container('buildkit') {
                    withCredentials([
                        usernamePassword(
                            credentialsId: 'ghcr-credentials',
                            usernameVariable: 'GHCR_USER',
                            passwordVariable: 'GHCR_TOKEN'
                        )
                    ]) {
                        sh '''#!/bin/sh
set -eu
set +x

umask 077

export DOCKER_CONFIG="$WORKSPACE/.docker"
mkdir -p "$DOCKER_CONFIG"

trap 'rm -rf "$DOCKER_CONFIG"' EXIT

AUTH=$(printf '%s:%s' \
  "$GHCR_USER" "$GHCR_TOKEN" \
  | base64 | tr -d '\\n')

printf '{"auths":{"ghcr.io":{"auth":"%s"}}}\\n' \
  "$AUTH" > "$DOCKER_CONFIG/config.json"

buildctl-daemonless.sh build \
  --frontend dockerfile.v0 \
  --local context=. \
  --local dockerfile=. \
  --output "type=image,name=${IMAGE_REF},push=true"
'''
                    }
                }
            }
        }

        stage('Deploy to Kubernetes') {
            steps {
                container('kubectl') {
                    sh '''
set -eu

kubectl -n default set image \
  deployment/nginx \
  nginx="$IMAGE_REF"

kubectl -n default rollout status \
  deployment/nginx \
  --timeout=180s
'''
                }
            }
        }
    }

    post {
        success {
            echo 'CI/CD 배포 성공'
        }
        failure {
            echo 'CI/CD 실패: Console Output 확인'
        }
    }
}
