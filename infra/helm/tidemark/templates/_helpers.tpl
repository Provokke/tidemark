{{- define "tidemark.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tidemark.fullname" -}}
{{- printf "%s-%s" .Release.Name (include "tidemark.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "tidemark.labels" -}}
app.kubernetes.io/name: {{ include "tidemark.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "tidemark.selector" -}}
app.kubernetes.io/name: {{ include "tidemark.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "tidemark.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{/* Environment shared by every container. */}}
{{- define "tidemark.env" -}}
- name: DATABASE_URL
  valueFrom:
    secretKeyRef:
      name: {{ .Values.database.existingSecret }}
      key: {{ .Values.database.key }}
- name: TIDEMARK_LOG_FORMAT
  value: json
- name: HOST
  value: "0.0.0.0"
{{- range $k, $v := .Values.env }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- end -}}

{{- define "tidemark.envFrom" -}}
{{- if .Values.envFromSecret }}
envFrom:
  - secretRef:
      name: {{ .Values.envFromSecret }}
{{- end }}
{{- end -}}

{{/* The bundle is written under the project directory: give it a writable place. */}}
{{- define "tidemark.volumes" -}}
volumes:
  - name: build
    emptyDir: {}
  - name: tmp
    emptyDir: {}
{{- end -}}

{{- define "tidemark.volumeMounts" -}}
volumeMounts:
  - name: build
    mountPath: /opt/tidemark/project/.tidemark
  - name: tmp
    mountPath: /tmp
{{- end -}}
