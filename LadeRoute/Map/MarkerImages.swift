//  MarkerImages.swift
//  Zeichnet die Kartennadeln programmatisch, damit der Prototyp ohne
//  Bild-Assets auskommt.

import UIKit

enum MarkerImages {
    /// Nadel für eine Ladestation. Rot, wenn die Redaktion sie bewertet hat,
    /// sonst grau. Die Zahl in der Nadel ist die Position entlang der Route.
    static func stationPin(index: Int, hasEditorial: Bool, isSelected: Bool) -> UIImage {
        let size = CGSize(width: 34, height: 44)
        let renderer = UIGraphicsImageRenderer(size: size)

        let fill = hasEditorial ? UIColor(hex: 0xB8361F) : UIColor(hex: 0x6B625A)
        let stroke = isSelected ? UIColor(hex: 0x1A1714) : UIColor.white

        return renderer.image { context in
            let ctx = context.cgContext
            let circleRect = CGRect(x: 2, y: 2, width: 30, height: 30)

            // Spitze nach unten.
            let path = UIBezierPath(ovalIn: circleRect)
            let tip = UIBezierPath()
            tip.move(to: CGPoint(x: 11, y: 27))
            tip.addLine(to: CGPoint(x: 17, y: 42))
            tip.addLine(to: CGPoint(x: 23, y: 27))
            tip.close()
            path.append(tip)

            ctx.setShadow(offset: CGSize(width: 0, height: 1), blur: 3, color: UIColor.black.withAlphaComponent(0.3).cgColor)
            fill.setFill()
            path.fill()
            ctx.setShadow(offset: .zero, blur: 0, color: nil)

            stroke.setStroke()
            path.lineWidth = isSelected ? 2.5 : 1.5
            path.stroke()

            let label = "\(index)" as NSString
            let attributes: [NSAttributedString.Key: Any] = [
                .font: UIFont.systemFont(ofSize: 15, weight: .semibold),
                .foregroundColor: UIColor.white,
            ]
            let textSize = label.size(withAttributes: attributes)
            label.draw(
                at: CGPoint(
                    x: circleRect.midX - textSize.width / 2,
                    y: circleRect.midY - textSize.height / 2
                ),
                withAttributes: attributes
            )
        }
    }
}
