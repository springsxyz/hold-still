Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$iconsDirectory = Join-Path $projectRoot "icons"
New-Item -ItemType Directory -Path $iconsDirectory -Force | Out-Null

function New-RoundedRectanglePath {
    param(
        [single]$X,
        [single]$Y,
        [single]$Width,
        [single]$Height,
        [single]$Radius
    )

    $diameter = $Radius * 2
    $path = [System.Drawing.Drawing2D.GraphicsPath]::new()
    $path.AddArc($X, $Y, $diameter, $diameter, 180, 90)
    $path.AddArc($X + $Width - $diameter, $Y, $diameter, $diameter, 270, 90)
    $path.AddArc($X + $Width - $diameter, $Y + $Height - $diameter, $diameter, $diameter, 0, 90)
    $path.AddArc($X, $Y + $Height - $diameter, $diameter, $diameter, 90, 90)
    $path.CloseFigure()
    return $path
}

foreach ($size in 16, 32, 48, 128) {
    $bitmap = [System.Drawing.Bitmap]::new(
        $size,
        $size,
        [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

    try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.ScaleTransform($size / 128, $size / 128)

        $coralBrush = [System.Drawing.SolidBrush]::new(
            [System.Drawing.ColorTranslator]::FromHtml("#E6553E")
        )
        $whiteBrush = [System.Drawing.SolidBrush]::new(
            [System.Drawing.ColorTranslator]::FromHtml("#FFFFFF")
        )
        $darkColor = [System.Drawing.ColorTranslator]::FromHtml("#241A15")
        $darkBrush = [System.Drawing.SolidBrush]::new($darkColor)
        $darkPen = [System.Drawing.Pen]::new($darkColor, 6)
        $darkPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round

        try {
            $browserWindow = New-RoundedRectanglePath 7 7 114 114 20

            try {
                $graphics.FillPath($whiteBrush, $browserWindow)
                $graphics.DrawPath($darkPen, $browserWindow)
                $graphics.DrawLine($darkPen, 10, 43, 118, 43)

                $graphics.FillEllipse($coralBrush, 22, 24, 7, 7)
                $graphics.FillEllipse($coralBrush, 34, 24, 7, 7)
                $graphics.FillEllipse($coralBrush, 46, 24, 7, 7)

                $graphics.FillEllipse($darkBrush, 34, 51, 60, 60)
                $graphics.FillEllipse($whiteBrush, 42, 59, 44, 44)
                $graphics.FillEllipse($coralBrush, 52, 69, 24, 24)
                $graphics.FillEllipse($whiteBrush, 58, 74, 7, 7)
            } finally {
                $browserWindow.Dispose()
            }
        } finally {
            $coralBrush.Dispose()
            $whiteBrush.Dispose()
            $darkBrush.Dispose()
            $darkPen.Dispose()
        }

        $outputPath = Join-Path $iconsDirectory ("icon" + $size + ".png")
        $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}
